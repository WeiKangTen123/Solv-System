import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useViewMode } from '../context/ViewModeContext';
import Insights from '../components/Insights';
import ClaimImport from '../components/receipts/ClaimImport';
import { ACCEPT_ATTR } from '../components/receipts/receipt-upload';
import { setPendingFiles } from '../components/intake/handoff';
import { PageHeader, DropZone, useWindowDrop, KindBadge, ProgressBar, Skeleton, Menu } from '../components/ui';
import { fmtMoney, fmtDateRange, fmtDay } from '../utils/format';
import { unpriced, unpricedText } from '../utils/caseTotals';
import { casePath, nextStep, readFailed, receiptName, receiptPath, skippedText, todoLinks } from '../utils/todo';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { useOnChanged } from '../utils/useOnChanged';

// The front door, built around what to do next: a place to drop receipts,
// what is waiting on the person as links straight to it, their open cases as
// cards with the one thing each needs, the receipts that are in no case, and
// the figures, folded away until asked for.
//
// Nothing here makes a case on its own. Files dropped or picked are handed to
// the New case page (components/intake/handoff.js), which uploads them into a
// draft and fills its details in as they are read, in front of the person.
// The page used to make a "Receipts, <date>" case for every batch, and people
// ended up with a case per afternoon.
const MAX_CARDS = 6;
const LOOSE_SHOWN = 5;
const MONEY_KEY = 'solv:home-money-open';

function ago(iso) {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (!Number.isFinite(d) || d < 0) return null;
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}
// Which month a moment falls in, where the company is. Asked in UTC, a case
// claimed before 08:00 on the 1st in Singapore counted towards the month before.
const monthIn = (d, tz) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Singapore', year: 'numeric', month: '2-digit' }).format(d).slice(0, 7); }
  catch { return d.toISOString().slice(0, 7); }
};
const thisMonth = (iso, tz) => !!iso && monthIn(new Date(iso), tz) === monthIn(new Date(), tz);
const sum = ns => Math.round(ns.reduce((s, n) => s + (Number(n) || 0), 0) * 100) / 100;

// Whether the figures were left open, per browser. Storage can be refused (a
// private window); then they start folded, which is the default anyway.
function moneyWasOpen() {
  try { return localStorage.getItem(MONEY_KEY) === '1'; } catch { return false; }
}
function rememberMoney(open) {
  try { localStorage.setItem(MONEY_KEY, open ? '1' : '0'); } catch { /* not remembered; nothing else depends on it */ }
}

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { isMobile } = useViewMode();
  const isAdmin = user?.role === 'admin';
  const base = user?.baseCurrency || 'SGD';

  // Each is null until its first answer: an empty list is "nothing there",
  // and the page must not say so while it is still asking.
  const [cases, setCases] = useState(null);        // the person's drafts and open cases
  const [loose, setLoose] = useState(null);        // their receipts in no case
  const [failed, setFailed] = useState(null);      // reads that came back with nothing
  const [everyone, setEveryone] = useState(null);  // an admin's view of the company's cases
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  // Bumped only when something changed the figures, which is what Insights
  // fetches again on; it is not polled.
  const [changed, setChanged] = useState(0);
  const [moneyOpen, setMoneyOpen] = useState(moneyWasOpen);
  const [importing, setImporting] = useState(false);
  const [importJob, setImportJob] = useState(null);

  // A few small questions rather than every receipt the person has: the
  // cases list carries each case's counts, and the receipts asked for are
  // only the ones this page shows.
  const load = useCallback(() => Promise.all([
    api.get('/reports?status=draft,open').then(d => setCases(d.reports || [])),
    api.get('/expenses?unfiled=1&status=reading,review-needed,reviewed').then(d => setLoose(d.expenses || [])),
    api.get('/expenses?status=review-needed').then(d => setFailed((d.expenses || []).filter(readFailed))),
    isAdmin ? api.get('/reports?scope=all').then(d => setEveryone(d.reports || [])).catch(() => setEveryone([])) : Promise.resolve(),
  ]).then(() => setMsg(m => (m && m.tone === 'error' ? null : m)))
    // Swallowed, the page read as "you have nothing" rather than "the list
    // could not be loaded".
    .catch(e => setMsg({ tone: 'error', text: `Could not load your cases: ${e.message}` })), [isAdmin]);
  useEffect(() => { load(); }, [load]);
  const reading = (cases || []).some(r => Number(r.reading) > 0) || (loose || []).some(e => e.status === 'reading');
  useVisiblePolling(load, () => (reading ? 2500 : 20000));
  // An edit the assistant applies shows here too, and moves the figures.
  useOnChanged(() => load().then(() => setChanged(n => n + 1)));

  // A running import survives closing its panel; GET /claims/active finds it
  // again, so its progress and its Undo are not lost.
  useEffect(() => {
    if (!importing) return undefined;
    let alive = true;
    api.get('/claims/active')
      .then(d => { if (alive) setImportJob((d && d.job && (d.job.id || d.job.jobId)) || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [importing]);

  // Receipts go to the New case page, which uploads them into a new draft.
  const start = useCallback(files => { setPendingFiles(files); navigate('/reports/new'); }, [navigate]);
  const drop = useWindowDrop(start, { enabled: !importing, label: 'Drop to start a new case with them' });

  const open = (cases || []).filter(r => r.status === 'open');
  const links = cases && failed ? todoLinks({ cases, failed }) : null;

  // Every receipt in no case, into one case: an open one, or a new draft the
  // New case page then shows. Refusals come back per receipt (a duplicate,
  // one claimed on its own) and are named rather than lost.
  async function fileLoose(target) {
    const list = loose || [];
    const ids = list.map(e => e.id);
    if (!ids.length || busy) return;
    setBusy(true); setMsg(null);
    let made = null;
    try {
      if (target === 'new') made = (await api.post('/reports', { draft: true })).report;
      const id = made ? made.id : target.id;
      const out = await api.post(`/reports/${id}/expenses`, { expenseIds: ids });
      const skipped = out.skipped || [];
      const why = skippedText(skipped, list, fmtDay);
      if (made && skipped.length >= ids.length) {
        // Nothing went in, so the draft is not a case; it goes again.
        await api.delete(`/reports/${made.id}?ifEmpty=1`).catch(() => {});
        setMsg({ tone: 'warning', text: `No case was started: ${why}.` });
        return;
      }
      if (made) { navigate(casePath(made.id, 'draft')); return; }
      await load();
      setChanged(n => n + 1);
      const n = ids.length - skipped.length;
      const where = target.number || target.title || 'the case';
      setMsg(skipped.length
        ? { tone: 'warning', text: `${n} put in ${where}. Not put in: ${why}.` }
        : { tone: 'success', text: `${n} receipt${n === 1 ? '' : 's'} put in ${where}.` });
    } catch (e) {
      if (made) api.delete(`/reports/${made.id}?ifEmpty=1`).catch(() => {});
      setMsg({ tone: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="hm-page">
      {drop.overlay}
      <PageHeader title={`${greeting}, ${user?.name || user?.email || ''}`}
                  subtitle="Drop your receipts and a case is put together from them while you watch." />

      {msg && <div className={`alert alert-${msg.tone}`} role={msg.tone === 'error' ? 'alert' : 'status'}>{msg.text}</div>}

      <section className="hm-start" aria-label="Start a case">
        <div className="hm-start-zone">
          <DropZone onFiles={start} accept={ACCEPT_ATTR} compact
                    label={isMobile ? 'Tap to add receipts' : 'Drop receipts anywhere here to start'}>
            {isMobile ? 'They go into a new case.' : 'or click to choose them. They go into a new case.'}
          </DropZone>
        </div>
        <div className="hm-start-actions">
          <Link to="/reports/new" className="btn btn-primary">+ New case</Link>
          {/* The code is shown on the New case page, beside the draft the
              photos go into: a code made here had no case to send them to.
              ?phone=1 opens it there straight away. */}
          {!isMobile && (
            <Link to="/reports/new?phone=1" className="btn btn-outline" title="Opens New case with a code to scan with your phone">
              Use my phone
            </Link>
          )}
        </div>
      </section>
      <div className="hm-start-more">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setImporting(true)}
                title="A zip of receipts with its claim form, as emailed">
          Import a claim form
        </button>
      </div>

      <section className="hm-section" aria-labelledby="hm-todo">
        <h2 id="hm-todo" className="section-label">To do</h2>
        {!links ? <div className="hm-todo-wait"><Skeleton rows={1} height={30} label="Loading what is waiting" /></div>
          : !links.length ? <p className="hm-quiet">Nothing is waiting on you.</p>
          : (
            <ul className="hm-todo">
              {links.map(l => (
                <li key={l.id}>
                  <Link to={l.to} className={`hm-todo-link is-${l.tone}`}>
                    <span>{l.label}</span><span aria-hidden="true">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className="hm-section" aria-labelledby="hm-open">
        <div className="hm-section-head">
          <h2 id="hm-open" className="section-label">Open cases{cases ? ` (${open.length})` : ''}</h2>
          {open.length > MAX_CARDS && <Link to="/reports?status=open" className="hm-more">All cases →</Link>}
        </div>
        {!cases ? (
          <div className="hm-cards">
            {[0, 1, 2].map(i => <div key={i} className="hm-card hm-card-wait"><Skeleton rows={4} label={i ? undefined : 'Loading your cases'} /></div>)}
          </div>
        ) : (
          <div className="hm-cards">
            {open.slice(0, MAX_CARDS).map(r => <CaseCard key={r.id} r={r} base={base} />)}
            <Link to="/reports/new" className="hm-card hm-card-new">
              <span className="hm-card-new-mark" aria-hidden="true">+</span>
              <span>New case</span>
              {!open.length && <span className="hm-card-new-hint">Drop receipts above and one is put together for you.</span>}
            </Link>
          </div>
        )}
      </section>

      {loose && loose.length > 0 && (
        <section className="hm-section" aria-labelledby="hm-loose">
          <div className="hm-section-head">
            <h2 id="hm-loose" className="section-label">Not in a case ({loose.length})</h2>
            <Menu label={busy ? 'Putting them in…' : 'Put them in a case'} align="end" disabled={busy}
                  items={[
                    ...open.map(r => ({ label: [r.number, r.title || 'Untitled case'].filter(Boolean).join(' · '),
                                        hint: r.periodFrom || r.periodTo ? fmtDateRange(r.periodFrom, r.periodTo) : undefined,
                                        onSelect: () => fileLoose(r) })),
                    { label: 'A new case', hint: 'A draft with these receipts in it', onSelect: () => fileLoose('new') },
                  ]} />
          </div>
          <ul className="hm-loose">
            {loose.slice(0, LOOSE_SHOWN).map(e => (
              <li key={e.id}>
                <Link to={receiptPath(e)} className="hm-loose-row">
                  <span className="hm-loose-day">{fmtDay(e.receiptDate)}</span>
                  <span className="hm-loose-name">{receiptName(e)}{readFailed(e) && <span className="hm-quiet"> · not read</span>}</span>
                  <span className="hm-num">{e.baseTotal != null ? fmtMoney(e.baseTotal, base) : Number(e.total) > 0 ? fmtMoney(e.total, e.currency) : '—'}</span>
                </Link>
              </li>
            ))}
            {loose.length > LOOSE_SHOWN && (
              <li><Link to="/expenses?show=unfiled" className="hm-loose-row hm-more">All {loose.length} in My receipts →</Link></li>
            )}
          </ul>
        </section>
      )}

      {isAdmin && <Everyone everyone={everyone} base={base} tz={user?.timezone} />}

      <details className="hm-fold" open={moneyOpen}
               onToggle={e => { const now = e.currentTarget.open; setMoneyOpen(now); rememberMoney(now); }}>
        <summary><span className="section-label">Where the money goes</span></summary>
        {/* Asked for only once opened: these are aggregates over months. */}
        {moneyOpen && <div className="hm-fold-body"><Insights refresh={changed} heading={false} /></div>}
      </details>

      {importing && (
        <ClaimImport key={importJob || 'new'} initialJobId={importJob} onImported={load}
                     onClose={() => { setImporting(false); setImportJob(null); }} />
      )}
    </div>
  );
}

// One open case: what it is, how far its checking has got, and the one thing
// to do next, which is the same as the Cases list's.
function CaseCard({ r, base }) {
  const n = Number(r.expenseCount) || 0;
  const checked = Math.max(0, n - (Number(r.unreviewed) || 0));
  const step = nextStep(r);
  // A receipt still being read has no amount yet either, and the reader is
  // about to give it one: only those it has finished with are waiting.
  const waiting = unpricedText({ ...r, noAmount: r.noAmount == null ? r.noAmount : Math.max(0, r.noAmount - (Number(r.reading) || 0)) }, { short: true });
  const dates = r.periodFrom || r.periodTo ? fmtDateRange(r.periodFrom, r.periodTo) : null;
  const tone = step.kind === 'reading' ? 'info' : n && checked === n ? 'success' : undefined;
  return (
    <article className="hm-card">
      <div className="hm-card-top">
        <Link to={`/reports/${r.id}`} className="hm-card-title">{r.title || 'Untitled case'}</Link>
        <KindBadge kind={r.kind} />
      </div>
      <div className="hm-card-meta">
        <span className="hm-num">{r.number}</span>
        {dates && <span>{dates}</span>}
        <span className="hm-num hm-card-total">{fmtMoney(r.totalBase, base)}</span>
      </div>
      {waiting && <div className="hm-card-warn">Not in the total: {waiting}</div>}
      {n > 0 ? (
        <div className="hm-card-progress">
          <ProgressBar value={checked} max={n} tone={tone} label={`Receipts checked in ${r.title || r.number}`} valueText={`${checked} of ${n} checked`} />
          <span className="hm-num hm-card-count">{checked}/{n} <span aria-hidden="true">✓</span></span>
        </div>
      ) : <div className="hm-card-empty">No receipts in it yet.</div>}
      <div className="hm-card-foot">
        {step.to
          ? <Link to={step.to} className={`btn btn-sm ${step.kind === 'check' || step.kind === 'claim' ? 'btn-primary' : 'btn-outline'}`}>{step.label} <span aria-hidden="true">→</span></Link>
          : <span className="hm-card-reading"><span className="hm-dot" aria-hidden="true" />{step.label} <span className="hm-quiet">{r.reading} left</span></span>}
      </div>
    </article>
  );
}

// An admin's look at the company: each figure opens the cases behind it.
function Everyone({ everyone, base, tz }) {
  const list = everyone || [];
  const open = list.filter(r => r.status === 'open');
  const ready = open.filter(r => r.ready);
  const claimed = list.filter(r => r.status === 'claimed' && thisMonth(r.claimedAt, tz));
  // Stuck is waiting on a rate, which nobody in the case can type their way
  // out of. A receipt without an amount is waiting on its owner instead.
  const stuck = open.filter(r => { const u = unpriced(r); return u.noRate + u.either > 0; });
  const stuckWhy = stuck.some(r => unpriced(r).either) ? 'without an amount or rate yet' : 'waiting for an exchange rate';
  const v = x => (everyone ? x : '…');
  const tiles = [
    { to: '/reports?scope=all&status=open', label: 'Open cases', value: v(open.length), sub: !everyone ? 'Loading…' : open.length ? fmtMoney(sum(open.map(r => r.totalBase)), base) : 'nothing open' },
    { to: '/reports?scope=all&ready=1', label: 'Ready to claim', value: v(ready.length), sub: !everyone ? 'Loading…' : ready.length ? fmtMoney(sum(ready.map(r => r.totalBase)), base) : 'none yet' },
    { to: '/reports?scope=all&status=claimed', label: 'Claimed this month', value: v(claimed.length), sub: !everyone ? 'Loading…' : claimed.length ? fmtMoney(sum(claimed.map(r => r.totalBase)), base) : 'nothing yet' },
    { to: '/reports?scope=all&status=open', label: 'Stuck', value: v(stuck.length), sub: !everyone ? 'Loading…' : stuck.length ? stuckWhy : 'nothing waiting', warn: stuck.length > 0 },
  ];
  return (
    <section className="hm-section" aria-labelledby="hm-everyone">
      <h2 id="hm-everyone" className="section-label">Everyone</h2>
      <div className="hm-tiles">
        {tiles.map(t => (
          <Link key={t.label} to={t.to} className="stat-card hm-tile">
            <span className="stat-label">{t.label}</span>
            <span className="stat-value" style={t.warn ? { color: 'var(--warning)' } : undefined}>{t.value}</span>
            <span className="stat-sub">{t.sub}</span>
          </Link>
        ))}
      </div>
      {claimed.length > 0 && (
        <div className="hm-recent">
          <h3 className="hm-sub">Claimed this month</h3>
          <ul className="hm-loose">
            {[...claimed].sort((a, b) => String(b.claimedAt).localeCompare(String(a.claimedAt))).slice(0, 6).map(r => (
              <li key={r.id}>
                <Link to={`/reports/${r.id}`} className="hm-loose-row">
                  <span className="hm-num hm-loose-ref">{r.number}</span>
                  <span className="hm-loose-name">{r.ownerName || r.ownerEmail} · {r.title || 'Untitled'}</span>
                  <span className="hm-num">{fmtMoney(r.totalBase, base)}</span>
                  <span className="hm-quiet">{ago(r.claimedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
