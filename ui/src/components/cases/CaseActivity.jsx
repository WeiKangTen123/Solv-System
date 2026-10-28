import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { EmptyState, FilterChips, Skeleton } from '../ui';
import { fmtRate } from '../../utils/format';
import { formatDate, formatTime } from '../../utils/formatDate';
import { fxSourceName } from '../../utils/fxSources';

// What happened to the case and to the receipts in it, as one timeline by
// day, newest first, and the exchange rates its receipts were priced at: the
// two things a finance reader asks after.
//
// The timeline is GET /reports/:id/activity (main/reports/activity.js), which
// puts the case's own history and every receipt's change log together and
// says who did each thing: a person (an admin marked as one, so the owner
// sees what an admin corrected), the AI, or the system (Xero). A receipt's
// entry opens it on the review page, or on its own page once it has left
// the case.
//
// Props:
//   report  the case (GET /reports/:id): `expenses` with lines, for the rates,
//           and what tells the timeline it is out of date.
//   base    the company's currency.
//   tz      the person's timezone, for the days and times.
//   active  the tab is showing. The timeline is asked for then, and again
//           when the case changes while it shows; not on every poll of a
//           page that is looking at its receipts.

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'person', label: 'People' },
  { id: 'ai', label: 'AI' },
  { id: 'system', label: 'System' },
];
const NONE_FOR = {
  all: 'Nothing recorded yet',
  person: 'Nobody has done anything here yet',
  ai: 'The AI has not changed anything here',
  system: 'Nothing from the system here',
};

// Each action said as a person would, after who did it: "Aisha Rahman
// checked 3 receipts", "✦ AI updated the details from the receipts". `R` is
// where the receipt's name goes, as a link. An action the server has that is
// not here yet still reads, in its own words.
const _n = item => Number(((item.text || '').match(/(\d+) receipts?/) || [])[1]) || (item.receipts || []).length || 1;
const _receipts = n => `${n} receipt${n === 1 ? '' : 's'}`;
const R = 'receipt-link';
const SAYS = {
  created:            i => [i.note === 'draft' ? 'started a draft' : 'created the case'],
  opened:             () => ['created the case'],
  claimed:            () => ['marked the case claimed'],
  reopened:           () => ['reopened the case'],
  details_edited:     () => ['edited the details'],
  ai_details:         () => ['updated the details from the receipts'],
  checked:            i => (i.scope === 'receipt' ? ['checked ', R] : [`checked ${_receipts(_n(i))}`]),
  unchecked:          () => ['marked ', R, ' to check again'],
  status:             () => ['changed the status of ', R],
  removed:            i => {
    const to = (String(i.note || '').match(/ \(moved to (.*)\)$/) || [])[1];
    return to ? ['moved ', R, ` to ${to}`] : ['took ', R, ' out of the case'];
  },
  deleted:            () => ['deleted a receipt'],
  posted:             () => ['posted the case to Xero'],
  xero_failed:        i => [/^Xero also made/.test(i.note || '') ? 'made a second bill' : 'refused the bill'],
  per_diem:           i => [/^Replaced/.test(i.text || '') ? 'replaced the per diem' : 'added a per diem'],
  mileage:            () => ['added mileage'],
  merged:             () => ['merged another case into this one'],
  edited:             i => (i.scope === 'receipt' ? ['edited ', R] : ['edited the case']),
  edited_after_claim: () => ['edited a receipt after the case was claimed'],
  filed:              () => ['added ', R, ' to the case'],
  moved_in:           i => ['moved ', R, ` here from ${i.old || 'another case'}`],
  moved_out:          i => ['moved ', R, ` to ${i.new || 'another case'}`],
  taken_out:          () => ['took ', R, ' out of the case'],
};
const said = item => (SAYS[item.action] ? SAYS[item.action](item)
  : [item.text ? item.text[0].toLowerCase() + item.text.slice(1) : String(item.action || 'did something').replace(/_/g, ' ')]);

// The lines under the headline: the fields edited, what the AI changed, the
// receipt deleted, Xero's own words; a receipt's save lists its fields.
const WHOLE_TEXT = new Set(['merged', 'edited', 'edited_after_claim']);
function detailOf(entry) {
  const first = entry.items[0];
  if (first.scope === 'receipt') return first.action === 'edited' || first.action === 'status' ? entry.items.map(i => i.detail).filter(Boolean) : [];
  if (first.action === 'removed') return first.receiptId ? [] : [first.detail].filter(Boolean);
  if (first.action === 'checked') return [];
  if (WHOLE_TEXT.has(first.action)) return first.text ? [first.text] : [];
  return first.detail ? [first.detail] : [];
}

// One save is one entry: the fields a person changed on one receipt at one
// moment, rather than a line each for the total, its line and its rate.
function entriesOf(items) {
  const out = [];
  for (const item of items) {
    const prev = out[out.length - 1] && out[out.length - 1].items[0];
    const same = prev && item.scope === 'receipt' && item.action === 'edited' && prev.scope === 'receipt' && prev.action === 'edited'
      && prev.receiptId === item.receiptId && prev.at === item.at && (prev.actor.id || '') === (item.actor.id || '');
    if (same) out[out.length - 1].items.push(item);
    else out.push({ key: item.id, items: [item] });
  }
  return out;
}

const VIA = { assistant: 'via the assistant', reread: 'by reading the receipt again' };

export default function CaseActivity({ report, base, tz, active = true }) {
  const { user } = useAuth();
  const [feed, setFeed] = useState(null);            // { items, next } once answered
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);           // an earlier page on its way
  const [filter, setFilter] = useState('all');

  // What the timeline was last asked for: a change to the case or to any
  // receipt in it is something new to show.
  const stamp = useMemo(() => [
    report.updatedAt, report.status, (report.events || []).length, (report.events || []).at(-1)?.at,
    ...(report.expenses || []).map(e => `${e.id}:${e.updatedAt}:${e.status}`),
  ].join('|'), [report]);
  const asked = useRef(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const d = await api.get(`/reports/${encodeURIComponent(report.id)}/activity`);
      if (n !== seq.current) return;
      setFeed(d); setError('');
    } catch (err) {
      if (n === seq.current) setError(err.message);
    }
  }, [report.id]);
  useEffect(() => {
    if (!active || asked.current === stamp) return;
    asked.current = stamp;
    load();
  }, [active, stamp, load]);

  async function earlier() {
    if (!feed || !feed.next || more) return;
    setMore(true);
    const n = seq.current;
    try {
      const d = await api.get(`/reports/${encodeURIComponent(report.id)}/activity?before=${encodeURIComponent(feed.next)}`);
      // A fresh first page landed meanwhile: this one belongs to the old list.
      if (n === seq.current) setFeed(f => ({ items: [...f.items, ...d.items], next: d.next }));
    } catch (err) { setError(err.message); }
    finally { setMore(false); }
  }

  const items = useMemo(() => (feed ? feed.items : []), [feed]);
  const counts = useMemo(() => {
    const c = { all: items.length, person: 0, ai: 0, system: 0 };
    for (const i of items) if (c[i.actor.type] !== undefined) c[i.actor.type]++;
    return c;
  }, [items]);
  const days = useMemo(() => {
    const shown = filter === 'all' ? items : items.filter(i => i.actor.type === filter);
    const out = [];
    for (const e of entriesOf(shown)) {
      const day = formatDate(e.items[0].at, tz);
      if (!out.length || out[out.length - 1].day !== day) out.push({ day, entries: [] });
      out[out.length - 1].entries.push(e);
    }
    return out;
  }, [items, filter, tz]);
  const today = formatDate(new Date().toISOString(), tz);
  const yesterday = formatDate(new Date(Date.now() - 86400000).toISOString(), tz);

  // In the case, its place on the review page; taken out or moved away, its
  // own page, which is where it now is.
  const hrefOf = (id, inCase) => (inCase === false ? `/expenses/${encodeURIComponent(id)}` : `/reports/${encodeURIComponent(report.id)}/review?receipt=${encodeURIComponent(id)}`);
  function receiptLink(item) {
    if (!item.receiptId) return <span className="ca-receipt">{String(item.detail || item.note || 'a receipt').replace(/ \(moved to .*\)$/, '')}</span>;
    return <Link className="ca-receipt" to={hrefOf(item.receiptId, item.inCase)}>{item.merchant || 'a receipt with no merchant'}</Link>;
  }
  function who(actor) {
    if (actor.type === 'ai') {
      return <span className="in-ai ca-ai" title="Done by the AI on its own"><span aria-hidden="true">✦ AI</span><span className="sr-only">The AI</span></span>;
    }
    const me = actor.type === 'person' && actor.id && actor.id === user?.id;
    return (
      <>
        <span className="ca-who">{me ? 'You' : actor.name}</span>
        {actor.role === 'admin' && <span className="ca-tag">admin</span>}
      </>
    );
  }

  // One rate per row, not per line: twelve taxis in rupees on one day are one
  // rate.
  const rates = [...new Map((report.expenses || []).flatMap(e => e.lines || [])
    .filter(l => l.fxRate && l.fxSource !== 'base')
    .map(l => [`${l.currency}|${l.fxRate}|${l.fxRateDate}|${l.fxSource}`, l])).values()];

  return (
    <div className="cs-activity">
      <section className="card ca-card" aria-labelledby="ca-title">
        <div className="ca-top">
          <h2 className="section-label" id="ca-title">History</h2>
          {feed && items.length > 0 && (
            <FilterChips label="Show what was done by" value={filter} onChange={setFilter}
                         options={FILTERS.map(f => ({ ...f, count: counts[f.id] }))} />
          )}
        </div>
        {error && (
          <div className="alert alert-error ca-error" role="alert">
            <span>The history could not be loaded: {error}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={load}>Try again</button>
          </div>
        )}
        {!feed && !error && <Skeleton rows={5} height={34} label="Loading the history" />}
        {feed && !days.length && <EmptyState compact title={NONE_FOR[filter]} />}
        {days.map(d => (
          <div key={d.day} className="ca-day">
            <h3 className="ca-day-head">{d.day === today ? 'Today' : d.day === yesterday ? 'Yesterday' : d.day}</h3>
            <ol className="ca-list">
              {d.entries.map(e => {
                const first = e.items[0];
                const lines = detailOf(e);
                return (
                  <li key={e.key} className={`ca-entry is-${first.actor.type}`}>
                    <span className="ca-dot" aria-hidden="true" />
                    <div className="ca-body">
                      <div className="ca-head">
                        {who(first.actor)}{' '}
                        <span className="ca-what">
                          {said(first).map((part, k) => (part === R ? <span key={k}>{receiptLink(first)}</span> : <span key={k}>{part}</span>))}
                        </span>
                        {first.actor.via && <span className="ca-via"> {VIA[first.actor.via] || `via ${first.actor.via}`}</span>}
                        {first.afterClaim && <span className="ca-tag is-warn">after the claim</span>}
                      </div>
                      {lines.length > 0 && (
                        <ul className="ca-detail">
                          {lines.map((l, k) => <li key={k}>{l}</li>)}
                        </ul>
                      )}
                      {first.receipts && first.receipts.length > 0 && (
                        <ul className="ca-receipts" aria-label="The receipts checked">
                          {first.receipts.map(r => (
                            <li key={r.id}><Link to={hrefOf(r.id, r.inCase)}>{r.merchant || 'A receipt with no merchant'}</Link></li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <time className="ca-when" dateTime={first.at} title={`${formatDate(first.at, tz)}, ${formatTime(first.at, tz)}`}>{formatTime(first.at, tz)}</time>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
        {feed && feed.next && (
          <div className="ca-more">
            <button type="button" className="btn btn-outline btn-sm" onClick={earlier} disabled={more}>{more ? 'Loading…' : 'Show earlier'}</button>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="section-label">Rates used</h2>
        {!rates.length ? (
          <div className="cs-sub">Every receipt so far is in {base}, or not priced yet.</div>
        ) : (
          <ul className="cs-rates">
            {rates.map(l => (
              <li key={`${l.currency}${l.fxRate}${l.fxRateDate}${l.fxSource}`}>
                {l.currency} → {base} <strong className="cs-num">{fmtRate(l.fxRate)}</strong>{' '}
                <span className="cs-sub">· {l.fxSource === 'manual' ? 'entered' : fxSourceName(l.fxSource)} {l.fxRateDate}{l.fxOverrideBy ? ` by ${l.fxOverrideBy}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
