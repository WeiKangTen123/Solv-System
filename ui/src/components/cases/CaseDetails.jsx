import { useCallback, useEffect, useId, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import { KindBadge, Checkbox } from '../ui';
import CoverForm from '../intake/CoverForm';
import { fmtDateRange, fmtMoney } from '../../utils/format';

// The case's cover: what it is, its title, dates, where (a trip), why, the
// advance and any notes. Read as a finished document until the owner presses
// Edit; then it is the New case page's form (CoverForm, saving as it is
// typed, with the AI's markers), so a case is described by one set of rules
// whether it is a draft or open. The kind can still change while the case is
// open. Nights and notes are not on that form (a draft has no use for them),
// so they sit under it and save the same way.
//
// "✦ Fill from receipts" (FillPanel) puts what the receipts say beside each
// detail the case has, for the owner to tick and apply, or to hand a detail
// back for the AI to keep up. The purpose is never in it: its "Suggest"
// offers choices that fill the field on the form (CoverForm).
//
// Done saves first and closes only once everything is saved: a failed save
// used to close the form over a change that was never kept.
//
// Props:
//   report      the case (GET /reports/:id), with `coverAi`.
//   cover       useCover(caseId) from the page, fed every load of the case.
//   suggestion  the AI's current cover from the intake panel, or null.
//   canEdit     the owner, and the case is open.
//   isOwner     the owner (a claimed case says how to change it).
//   base        the company's currency.
//   editing, onEdit(bool)  the page holds whether the form is open.
//
// A change made from the panel is sent on its own and the page is told the
// way the assistant tells it ('solv:changed'), so it loads the case again.
const AI_TIP = 'Filled from your receipts';

function AiMark() {
  return (
    <span className="in-ai" title={AI_TIP}>
      <span aria-hidden="true">✦ AI</span>
      <span className="sr-only">, filled by the AI from your receipts</span>
    </span>
  );
}

function Fact({ label, ai, wide, action, children }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <div className={`cs-fact${wide ? ' is-wide' : ''}`}>
      <dt>{label} {ai && <AiMark />} {action}</dt>
      <dd className={empty ? 'cs-none' : undefined}>{empty ? '—' : children}</dd>
    </div>
  );
}

export default function CaseDetails({ report: r, cover, suggestion, canEdit, isOwner, base, editing, onEdit }) {
  const auto = new Set((r.coverAi && r.coverAi.auto) || []);
  const trip = r.kind === 'trip';
  const uid = useId().replace(/:/g, '');
  const [filling, setFilling] = useState(false);
  const [purposeOpen, setPurposeOpen] = useState(false);
  const [doneError, setDoneError] = useState('');
  const [closing, setClosing] = useState(false);
  const fillRef = useRef(null);
  useEffect(() => { if (!canEdit) setFilling(false); }, [canEdit]);

  function edit(suggestPurpose = false) {
    setDoneError('');
    setPurposeOpen(suggestPurpose);
    setFilling(false);
    onEdit(true);
  }
  async function done() {
    if (closing) return;
    setClosing(true); setDoneError('');
    try {
      await cover.flush();
      setPurposeOpen(false);
      onEdit(false);
    } catch (err) {
      setDoneError(err.message || 'Not saved');
    } finally { setClosing(false); }
  }

  if (editing && canEdit) {
    return (
      <section className="card cs-details is-editing">
        <CoverForm cover={cover} suggestion={suggestion} base={base} purposeOpen={purposeOpen} />
        <Extras report={r} cover={cover} trip={cover.values.kind === 'trip'} nightsAi={auto.has('nights')} />
        {doneError && (
          <div className="alert alert-error cs-done-error" role="alert">
            <span className="alert-icon">✕</span>
            <span>Not saved: {doneError}. What you typed is still here; press Done to try again.</span>
          </div>
        )}
        <div className="cs-details-foot">
          <button type="button" className="btn btn-primary btn-sm" onClick={done} disabled={closing}>{closing ? 'Saving…' : 'Done'}</button>
        </div>
      </section>
    );
  }

  return (
    <section className="card cs-details" aria-labelledby="cs-details-head">
      <div className="cs-details-head">
        <h2 id="cs-details-head" className="section-label">Case details</h2>
        {canEdit && (
          <div className="cs-details-actions">
            <button type="button" ref={fillRef} className="btn btn-outline btn-sm" aria-expanded={filling} aria-controls={`${uid}-fill`}
                    onClick={() => setFilling(o => !o)}>
              <span aria-hidden="true">✦ </span>Fill from receipts
            </button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => edit(false)}>Edit</button>
          </div>
        )}
      </div>
      {filling && canEdit && <FillPanel id={`${uid}-fill`} report={r} onClose={() => { setFilling(false); fillRef.current?.focus(); }} />}
      <dl className="cs-facts">
        <Fact label="Kind" ai={auto.has('kind')}><KindBadge kind={r.kind} /></Fact>
        <Fact label="Number">{r.number}</Fact>
        <Fact label="Title" ai={auto.has('title')} wide>{r.title}</Fact>
        <Fact label="Dates" ai={auto.has('periodFrom') || auto.has('periodTo')}>
          {r.periodFrom || r.periodTo ? fmtDateRange(r.periodFrom, r.periodTo) : null}
        </Fact>
        {trip && <Fact label="Where" ai={auto.has('destination')}>{r.destination}</Fact>}
        {trip && <Fact label="Nights" ai={auto.has('nights')}>{r.nights === null || r.nights === undefined ? null : String(r.nights)}</Fact>}
        <Fact label="Purpose" wide action={canEdit && (
          <button type="button" className="btn btn-ghost btn-sm cs-fact-act" onClick={() => edit(true)}>
            <span aria-hidden="true">✦ </span>Suggest<span className="sr-only"> a purpose</span>
          </button>
        )}>{r.purpose}</Fact>
        <Fact label="Advance">{Number(r.advances) > 0 ? fmtMoney(r.advances, base) : null}</Fact>
        <Fact label="Notes" wide>{r.notes}</Fact>
      </dl>
      {!canEdit && isOwner && r.status === 'claimed' && !r.xeroInvoiceId && (
        <div className="cs-sub cs-details-note">A claimed case is locked. Reopen it (under ⋯ at the top) to change its details.</div>
      )}
    </section>
  );
}

// ── Fill from receipts ───────────────────────────────────────────────────────
// One row per detail the AI can say something about, for the kind the case
// is: what the case has, what its receipts say, a tick where they differ,
// and "Let the AI keep this up" for a detail the person owns that the AI can
// keep (GET /reports/:id/cover-suggestions says which). Apply PATCHes the
// ticked details, which become the person's like anything typed; handing one
// back (POST /reports/:id/cover-ai) gives it the receipts' value now and
// keeps it in step with them from then on.
// `noun` is the detail in a sentence ("Filled the title and destination").
const ROWS = [
  { key: 'title', label: 'Title', noun: 'title', fields: ['title'] },
  { key: 'dates', label: 'Dates', noun: 'dates', fields: ['periodFrom', 'periodTo'] },
  { key: 'destination', label: 'Where', noun: 'destination', fields: ['destination'], trip: true },
  { key: 'nights', label: 'Nights', noun: 'nights', fields: ['nights'], trip: true },
];
const _blank = v => v === null || v === undefined || v === '';
const _same = (a, b) => (_blank(a) ? _blank(b) : !_blank(b) && String(a) === String(b));
const _and = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
function _shown(row, vals) {
  if (!vals) return null;
  if (row.key === 'dates') return vals.periodFrom || vals.periodTo ? fmtDateRange(vals.periodFrom, vals.periodTo) : null;
  const v = vals[row.fields[0]];
  return _blank(v) ? null : String(v);
}
// What the panel can do with a row, from the server's answer.
function _row(row, d) {
  const differs = !!d.fields && row.fields.some(f => !_same(d.fields[f], d.current[f]));
  const offers = !!d.fields && row.fields.some(f => !_blank(d.fields[f]));
  const marked = row.fields.every(f => (d.coverAi.auto || []).includes(f));
  const keepable = row.fields.every(f => (d.aiCanKeep || []).includes(f));
  // Marked as the AI's is not the same as kept up by it: on an open case the
  // AI keeps only the dates, where and nights, so a title it wrote when the
  // case was made says so rather than promising to follow the receipts.
  const aiKeeps = marked && keepable;
  const theirs = row.fields.some(f => (d.coverAi.user || []).includes(f) || !_blank(d.current[f]));
  return { ...row, tickable: differs && offers, aiKeeps, aiFilled: marked && !keepable, canHandBack: keepable && !aiKeeps && theirs };
}
// "From 4 receipts in Mumbai and Pune, 31 Aug – 4 Sep 2026."
function _source(b) {
  if (!b) return null;
  const places = (b.cities && b.cities.length ? b.cities : b.countries) || [];
  return `From ${b.receipts} receipt${b.receipts === 1 ? '' : 's'}${places.length ? ` in ${_and(places)}` : ''}, ${fmtDateRange(b.from, b.to)}.`;
}
const _changed = () => window.dispatchEvent(new CustomEvent('solv:changed', { detail: {} }));

function FillPanel({ id, report, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [ticked, setTicked] = useState(() => new Set());
  const [busy, setBusy] = useState('');                // 'apply' | a row's key
  const [said, setSaid] = useState('');
  const headRef = useRef(null);

  // Asked when the panel opens, and again when the case moves under it (a
  // read lands, a field is saved); ticks are set afresh only when asked to.
  const load = useCallback(async ({ retick = false } = {}) => {
    try {
      const got = await api.get(`/reports/${report.id}/cover-suggestions`);
      setD(got); setError('');
      const rows = ROWS.filter(row => !row.trip || got.current.kind === 'trip').map(row => _row(row, got));
      setTicked(prev => new Set(rows.filter(row => row.tickable && (retick || prev.has(row.key))).map(row => row.key)));
    } catch (err) { setError(err.message || 'What the receipts say could not be loaded.'); }
  }, [report.id]);
  useEffect(() => { load({ retick: true }); }, [load]);
  const moved = `${report.updatedAt}|${report.kind}|${report.expenses.length}|${report.expenses.filter(e => e.status === 'reading').length}`;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    load();
  }, [moved, load]);
  useEffect(() => { headRef.current?.focus(); }, []);

  const rows = d ? ROWS.filter(row => !row.trip || d.current.kind === 'trip').map(row => _row(row, d)) : [];
  const n = rows.filter(row => ticked.has(row.key)).length;

  async function apply() {
    const chosen = rows.filter(row => ticked.has(row.key) && row.tickable);
    if (!chosen.length || busy) return;
    setBusy('apply'); setSaid(''); setError('');
    const body = {};
    for (const row of chosen) for (const f of row.fields) body[f] = d.fields[f] ?? '';
    try {
      await api.patch(`/reports/${report.id}`, body);
      const names = _and(chosen.map(row => row.noun));
      setSaid(`Filled the ${names} from your receipts. ${chosen.length === 1 ? 'It is' : 'They are'} yours now: the AI will not change ${chosen.length === 1 ? 'it' : 'them'}.`);
      _changed();
      await load({ retick: true });
    } catch (err) { setError(`Not applied: ${err.message}`); }
    finally { setBusy(''); }
  }
  async function handBack(row) {
    if (busy) return;
    setBusy(row.key); setSaid(''); setError('');
    try {
      await api.post(`/reports/${report.id}/cover-ai`, { fields: row.fields });
      setSaid(`The AI keeps the ${row.noun} up to date from your receipts now.`);
      _changed();
      await load();
    } catch (err) { setError(`Not handed back: ${err.message}`); }
    finally { setBusy(''); }
  }
  const tick = (key, on) => setTicked(prev => { const next = new Set(prev); if (on) next.add(key); else next.delete(key); return next; });

  return (
    <div id={id} className="cf-panel" role="region" aria-labelledby={`${id}-head`}
         onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="cf-head">
        <h3 id={`${id}-head`} ref={headRef} tabIndex={-1} className="cf-title"><span aria-hidden="true">✦ </span>Fill from receipts</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close<span className="sr-only"> fill from receipts</span></button>
      </div>
      {!d && !error && <div className="cf-source" role="status">Reading what your receipts say…</div>}
      {d && (
        <div className="cf-source">
          {d.fields ? _source(d.basis) : 'No receipt in this case has been read with a date yet, so there is nothing to fill from.'}
        </div>
      )}
      {d && d.fields && (
        <>
          <ul className="cf-rows">
            {rows.map(row => {
              const now = _shown(row, d.current), sug = _shown(row, d.fields);
              return (
                <li key={row.key} className={`cf-row${row.tickable ? ' is-diff' : ''}`}>
                  <div className="cf-pick">
                    {row.tickable ? (
                      <Checkbox checked={ticked.has(row.key)} onChange={on => tick(row.key, on)} disabled={!!busy}>
                        {row.label}<span className="sr-only">: use {sug || 'nothing'} from your receipts instead of {now || 'nothing'}</span>
                      </Checkbox>
                    ) : <span className="cf-label">{row.label}</span>}
                  </div>
                  <div className="cf-now">
                    <span className="cf-tag">Now</span>
                    <span className={now ? 'cf-val' : 'cf-val cs-none'}>{now || '—'}</span>
                  </div>
                  <div className="cf-new">
                    <span className="cf-tag">Your receipts</span>
                    <span className={sug ? 'cf-val' : 'cf-val cs-none'}>{sug || '—'}</span>
                    {!row.tickable && <span className="cf-same">{sug && _same(sug, now) ? 'Same' : !sug ? 'Nothing to go on' : ''}</span>}
                  </div>
                  <div className="cf-keep">
                    {row.aiKeeps
                      ? <span className="cf-kept">The AI keeps this up</span>
                      : row.aiFilled ? <span className="cf-kept">Filled by the AI</span>
                      : row.canHandBack && (
                        <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => handBack(row)}
                                title="Take the receipts' value now, and let the AI keep it in step with them">
                          {busy === row.key ? 'Handing back…' : 'Let the AI keep this up'}<span className="sr-only">: the {row.noun}</span>
                        </button>
                      )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="cf-foot">
            <span className="cf-hint">{rows.some(row => row.tickable)
              ? 'What you apply becomes yours, and the AI leaves it alone.'
              : 'Every detail already matches your receipts.'}</span>
            {rows.some(row => row.tickable) && (
              <button type="button" className="btn btn-primary btn-sm" onClick={apply} disabled={!n || !!busy}>
                {busy === 'apply' ? 'Applying…' : `Apply ${n || ''}${n ? ' ' : ''}${n === 1 ? 'detail' : 'details'}`}
              </button>
            )}
          </div>
        </>
      )}
      {error && <div className="cf-error" role="alert">{error}</div>}
      <div className="cf-said" role="status">{said}</div>
    </div>
  );
}

// Nights (a trip) and notes, saved through the same useCover as the form
// above, so one "Saving… / Saved" speaks for all of it. useCover keeps only
// the form's own fields in step with the server, so these two keep theirs
// here: the server's value until the person types in the field.
function Extras({ report, cover, trip, nightsAi }) {
  const uid = useId().replace(/:/g, '');
  const typed = useRef(new Set());
  const fromReport = () => ({ nights: report.nights === null || report.nights === undefined ? '' : String(report.nights), notes: report.notes || '' });
  const [vals, setVals] = useState(fromReport);
  useEffect(() => {
    const now = fromReport();
    setVals(v => ({ nights: typed.current.has('nights') ? v.nights : now.nights, notes: typed.current.has('notes') ? v.notes : now.notes }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.nights, report.notes]);
  const set = (k, v) => { typed.current.add(k); setVals(x => ({ ...x, [k]: v })); cover.change({ [k]: v }); };
  const field = k => ({ id: `${uid}-${k}`, value: vals[k], onFocus: () => cover.focus(k), onBlur: () => cover.blur(k), onChange: e => set(k, e.target.value) });

  return (
    <div className="cs-extras">
      {trip && (
        <div className="form-group cs-nights">
          <label className="form-label" htmlFor={`${uid}-nights`}>Nights {nightsAi && !typed.current.has('nights') && <AiMark />}</label>
          <input className="form-input in-money" type="number" inputMode="numeric" min="0" step="1" {...field('nights')} />
        </div>
      )}
      <div className="form-group">
        <label className="form-label" htmlFor={`${uid}-notes`}>Notes</label>
        <textarea className="form-input" rows={3} maxLength={2000} placeholder="Anything finance should know" {...field('notes')} />
      </div>
    </div>
  );
}
