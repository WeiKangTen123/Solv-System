import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import ReceiptUpload from '../components/receipts/ReceiptUpload';
import ExpenseTable from '../components/ExpenseTable';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { Link, useNavigate } from 'react-router-dom';
import Insights from '../components/Insights';
import { fmtMoney } from '../utils/format';
import { unpriced, unpricedCount, unpricedText } from '../utils/caseTotals';
import { useOnChanged } from '../utils/useOnChanged';
import { useConfirm } from '../context/ConfirmContext';

// Whole days since an ISO timestamp, as a sentence fragment.
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

// The front door. Everyone's is the same shape — their cases, what those need,
// where the money went — because everyone here does the same job. An admin
// sees the company's cases above their own, since the admin's seat is for
// watching it work.
export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';
  const confirm = useConfirm();
  // Only what the page shows: receipts that need checking, and checked ones not
  // in a case. It used to fetch every receipt the person ever had, every
  // twenty seconds, to filter them here.
  // null until the first answer: an empty list is "nothing there", and the
  // page used to say so ("nothing open", SGD 0.00) while it was still asking.
  const [needing, setNeeding] = useState(null);
  const [unfiled, setUnfiled] = useState(null);
  const [reports, setReports] = useState(null);
  const [everyone, setEveryone] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);
  // What each "File into…" box says. Left to itself the box kept showing the
  // case it was pointed at after a refusal, as if the receipt had gone there.
  const [filing, setFiling] = useState({});
  // Bumped only when something changed the figures, which is what Insights
  // re-fetches on. Marking a claim used to leave the dashboard below showing
  // the total from before the click.
  const [changed, setChanged] = useState(0);

  const load = useCallback(() => Promise.all([
    api.get('/expenses?status=review-needed,reading').then(d => setNeeding(d.expenses)),
    api.get('/expenses?status=reviewed&unfiled=1').then(d => setUnfiled(d.expenses)),
    api.get('/reports').then(d => setReports(d.reports)),
    isAdmin ? api.get('/reports?scope=all').then(d => setEveryone(d.reports || [])).catch(() => setEveryone([])) : Promise.resolve(),
  ]).then(() => setMsg(m => (m && m.tone === 'error' ? null : m)))
    // Swallowing this rendered an empty home page, which reads as "you have no
    // expenses" rather than "the list could not be loaded".
    .catch(e => setMsg({ tone: 'error', text: `Could not load your cases: ${e.message}` })), [isAdmin]);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, () => ((needing || []).some(e => e.status === 'reading') ? 2500 : 20000));
  // An edit the assistant applies shows here too, and moves the figures below.
  useOnChanged(() => load().then(() => setChanged(n => n + 1)));

  const base = user?.baseCurrency || 'SGD';
  const sum = ns => Math.round(ns.reduce((s, n) => s + (Number(n) || 0), 0) * 100) / 100;
  const loaded = reports !== null;

  const open = (reports || []).filter(r => r.status === 'open');
  const claimedThisMonth = (reports || []).filter(r => r.status === 'claimed' && thisMonth(r.claimedAt, user?.timezone));
  // Ready means the claim button will work: every receipt checked, every line
  // priced. The list carries both counts so nothing has to be opened to know.
  const ready = r => r.expenseCount > 0 && !r.unreviewed && !unpricedCount(r);
  // A receipt with no amount yet, or one still waiting for an exchange rate,
  // has no base figure, so it adds nothing to the total. Left unsaid, the tile
  // quietly understates what is open and nothing on the screen says why.
  // Reviewed receipts outside a case only ever wait for a rate.
  const apart = (reports || []).some(r => r.noAmount !== undefined && r.noAmount !== null);
  const awaiting = unpricedText({
    pendingRates: sum(open.map(r => r.pendingRates)) + (unfiled || []).filter(e => e.fxPending).length,
    noAmount: apart ? sum(open.map(r => r.noAmount)) : undefined,
  });

  const openEveryone = (everyone || []).filter(r => r.status === 'open');
  const claimedEveryone = (everyone || []).filter(r => r.status === 'claimed' && thisMonth(r.claimedAt, user?.timezone));
  // Stuck is waiting on a rate, which nobody in the case can type their way
  // out of. A receipt without an amount is waiting on its owner instead.
  const stuck = openEveryone.filter(r => { const u = unpriced(r); return u.noRate + u.either > 0; });
  // Before the server counted the two apart, a case here might be either.
  const stuckWhy = stuck.some(r => unpriced(r).either) ? 'without an amount or rate yet' : 'waiting for an exchange rate';

  async function act(key, fn, done) {
    setBusy(key);
    try { await fn(); await load(); setChanged(n => n + 1); setMsg({ tone: 'success', text: done }); }
    catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(null); }
  }
  // One click used to mark a case claimed, which locks it.
  async function markClaimed(r) {
    const yes = await confirm({
      title: `Mark ${r.number} claimed?`,
      message: 'Do this once the claim has gone through your company. Its receipts are then locked; you can reopen it until it is posted to Xero.',
      confirmLabel: 'Mark claimed',
    });
    if (yes) await act(r.id, () => api.post(`/reports/${r.id}/claimed`, {}), `${r.number} marked claimed.`);
  }
  async function fileInto(expenseId, reportId) {
    if (!reportId) return;
    setFiling(f => ({ ...f, [expenseId]: reportId }));
    try {
      // The server answers 200 with a `skipped` list for anything it refused
      // (not reviewed, already in another case). Ignoring it made a refusal
      // look like a success and left the receipt where it was.
      const r = await api.post(`/reports/${reportId}/expenses`, { expenseIds: [expenseId] });
      await load();
      const why = (r.skipped || []).find(s => s.id === expenseId);
      if (!why) setChanged(n => n + 1);
      setMsg(why ? { tone: 'warning', text: `Not filed: ${why.why}.` } : { tone: 'success', text: 'Filed into the case.' });
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setFiling(f => ({ ...f, [expenseId]: '' })); }
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const rowStyle = { display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: 13 };
  const num = { fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' };
  const muted = { fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' };

  // Not every receipt waiting here was read by the AI: some are still being
  // read, and one the reader could not make out was never read at all. The
  // tile used to call them all "read by AI".
  const readingNow = (needing || []).filter(e => e.status === 'reading').length;
  const needingSub = !needing ? 'Loading…'
    : !needing.length ? 'nothing to check'
    : needing.every(e => e.aiReadAt && e.status !== 'reading') ? 'read by AI, waiting for you'
    : readingNow ? `${readingNow} still being read`
    : 'waiting for you';

  // What a case row says about itself, in one phrase.
  const state = r => {
    const waiting = unpricedText(r, { short: true });
    if (waiting) return { text: waiting, tone: 'var(--warning)' };
    if (r.unreviewed > 0) return { text: `${r.unreviewed} to check`, tone: 'var(--warning)' };
    if (!r.expenseCount) return { text: 'empty', tone: 'var(--text-muted)' };
    return { text: 'ready to claim', tone: 'var(--success)' };
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>{greeting}, {user?.name || user?.email}</h1>
          <p>Add receipts and the reader fills in the merchant, date, amount and category.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Whatever is added here becomes a case, and the page goes to it. */}
          <ReceiptUpload onUploaded={load} onCase={c => navigate(`/reports/${c.id}`)} />
          {/* Straight to the form: this used to land on the list of cases with
              the form closed, one more click from what was asked for. */}
          <Link to="/reports?new=1" className="btn btn-outline">+ New case</Link>
        </div>
      </div>

      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}

      {isAdmin && (
        <div style={{ marginBottom: 24 }}>
          <div className="section-label">Everyone</div>
          <div className="grid-3" style={{ marginBottom: 14 }}>
            <div className="stat-card">
              <div className="stat-label">Open cases</div>
              <div className="stat-value">{everyone ? openEveryone.length : '…'}</div>
              <div className="stat-sub">{!everyone ? 'Loading…' : openEveryone.length ? fmtMoney(sum(openEveryone.map(r => r.totalBase)), base) : 'nothing open'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Claimed this month</div>
              <div className="stat-value">{everyone ? claimedEveryone.length : '…'}</div>
              <div className="stat-sub">{!everyone ? 'Loading…' : claimedEveryone.length ? fmtMoney(sum(claimedEveryone.map(r => r.totalBase)), base) : 'nothing yet'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Stuck</div>
              <div className="stat-value" style={stuck.length ? { color: 'var(--warning)' } : undefined}>{everyone ? stuck.length : '…'}</div>
              <div className="stat-sub">{!everyone ? 'Loading…' : stuck.length ? stuckWhy : 'nothing waiting'}</div>
            </div>
          </div>
          {claimedEveryone.length > 0 && (
            <div className="card">
              <div className="card-title">Recently claimed</div>
              {[...claimedEveryone].sort((a, b) => String(b.claimedAt).localeCompare(String(a.claimedAt))).slice(0, 6).map(r => (
                <Link key={r.id} to={`/reports/${r.id}`} style={{ ...rowStyle, color: 'inherit', textDecoration: 'none' }}>
                  <span style={{ ...num, color: 'var(--text-muted)' }}>{r.number}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{r.ownerName || r.ownerEmail} · {r.title || 'Untitled'}</span>
                  <span style={num}>{fmtMoney(r.totalBase, base)}</span>
                  <span style={muted}>{ago(r.claimedAt)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {isAdmin && <div className="section-label">Your own cases</div>}
      <div className="grid-3" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Open</div>
          <div className="stat-value">{loaded ? fmtMoney(sum(open.map(r => r.totalBase)), base) : '…'}</div>
          <div className="stat-sub" style={awaiting ? { color: 'var(--warning)' } : undefined}>
            {!loaded ? 'Loading…' : awaiting ? `Not counted: ${awaiting}` : open.length ? `${open.length} case${open.length === 1 ? '' : 's'}` : 'nothing open'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Claimed this month</div>
          <div className="stat-value">{loaded ? fmtMoney(sum(claimedThisMonth.map(r => r.totalBase)), base) : '…'}</div>
          <div className="stat-sub">{!loaded ? 'Loading…' : claimedThisMonth.length ? `${claimedThisMonth.length} case${claimedThisMonth.length === 1 ? '' : 's'}` : 'nothing yet'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Needs your check</div>
          <div className="stat-value">{needing ? needing.length : '…'}</div>
          <div className="stat-sub">{needingSub}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Open cases{loaded ? ` (${open.length})` : ''}</div>
        <div className="card-subtitle">Receipts go in until you put the claim through; then mark it claimed here and it is done.</div>
        {!loaded ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</div>
          : !open.length ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No open cases. Add receipts above and one is made for them.</div> : open.map(r => {
          const s = state(r);
          return (
            <div key={r.id} style={{ ...rowStyle, flexWrap: 'wrap' }}>
              <span style={{ ...num, color: 'var(--text-muted)' }}>{r.number}</span>
              <Link to={`/reports/${r.id}`} style={{ flex: '1 1 160px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: 'inherit' }}>{r.title || 'Untitled'}</Link>
              <span style={muted}>{r.expenseCount} receipt{r.expenseCount === 1 ? '' : 's'}</span>
              <span style={num}>{fmtMoney(r.totalBase, base)}</span>
              <span style={{ ...muted, color: s.tone }}>{s.text}</span>
              {ready(r)
                ? <button className="btn btn-primary btn-sm" disabled={busy === r.id} onClick={() => markClaimed(r)}>{busy === r.id ? 'Marking…' : 'Claimed'}</button>
                : <Link to={r.unreviewed > 0 ? `/reports/${r.id}/check` : `/reports/${r.id}`} className="btn btn-outline btn-sm">{r.unreviewed > 0 ? 'Check' : 'Open'}</Link>}
            </div>
          );
        })}
      </div>

      {unfiled && unfiled.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">Checked, not in a case ({unfiled.length})</div>
          <div className="card-subtitle">Pick a case to file each one into.</div>
          {unfiled.map(e => (
            <div key={e.id} style={{ ...rowStyle, flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 140px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.receiptDate || '—'} · {e.merchant || 'Untitled'}</span>
              <span style={num}>{e.baseTotal != null ? fmtMoney(e.baseTotal, base) : fmtMoney(e.total, e.currency)}</span>
              <select className="form-input" style={{ flex: '1 1 150px', maxWidth: 200, padding: '4px 8px', fontSize: 12 }}
                      value={filing[e.id] || ''} disabled={!!filing[e.id]} onChange={ev => fileInto(e.id, ev.target.value)} aria-label="File into case">
                <option value="">File into…</option>
                {open.map(r => <option key={r.id} value={r.id}>{r.number} {r.title || ''}</option>)}
              </select>
            </div>))}
        </div>
      )}

      <Insights refresh={changed} />

      <div className="card">
        <div className="card-title">Needs your check{needing ? ` (${needing.length})` : ''}</div>
        <div className="card-subtitle">Check the fields against the receipt, add the business purpose, then mark it reviewed.</div>
        <ExpenseTable expenses={needing} empty="Nothing waiting. Add a receipt above." />
      </div>
    </div>
  );
}
