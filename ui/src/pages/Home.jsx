import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import ReceiptUpload from '../components/receipts/ReceiptUpload';
import ExpenseTable from '../components/ExpenseTable';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { Link } from 'react-router-dom';
import Insights from '../components/Insights';
import { fmtMoney } from '../utils/format';

// Whole days since an ISO timestamp, as a sentence fragment.
function ago(iso) {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (!Number.isFinite(d) || d < 0) return null;
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}
const thisMonth = iso => !!iso && String(iso).slice(0, 7) === new Date().toISOString().slice(0, 7);

// The front door. Everyone's is the same shape — their cases, what those need,
// where the money went — because everyone here does the same job. An admin
// sees the company's cases above their own, since the admin's seat is for
// watching it work.
export default function Home() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [expenses, setExpenses] = useState([]);
  const [reports, setReports] = useState([]);
  const [everyone, setEveryone] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);
  // Bumped only when something changed the figures, which is what Insights
  // re-fetches on. Marking a claim used to leave the dashboard below showing
  // the total from before the click.
  const [changed, setChanged] = useState(0);

  const load = useCallback(() => Promise.all([
    api.get('/expenses').then(d => setExpenses(d.expenses)),
    api.get('/reports').then(d => setReports(d.reports)),
    isAdmin ? api.get('/reports?scope=all').then(d => setEveryone(d.reports || [])).catch(() => setEveryone([])) : Promise.resolve(),
  ]).then(() => setMsg(m => (m && m.tone === 'error' ? null : m)))
    // Swallowing this rendered an empty home page, which reads as "you have no
    // expenses" rather than "the list could not be loaded".
    .catch(e => setMsg({ tone: 'error', text: `Could not load your cases: ${e.message}` })), [isAdmin]);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, () => (expenses.some(e => e.status === 'reading') ? 2500 : 20000));

  const base = user?.baseCurrency || 'SGD';
  const sum = ns => Math.round(ns.reduce((s, n) => s + (Number(n) || 0), 0) * 100) / 100;

  const needing = expenses.filter(e => e.status === 'review-needed' || e.status === 'reading');
  const unfiled = expenses.filter(e => e.status === 'reviewed' && !e.reportId);
  const open = reports.filter(r => r.status === 'open');
  const claimedThisMonth = reports.filter(r => r.status === 'claimed' && thisMonth(r.claimedAt));
  // Ready means the claim button will work: every receipt checked, every line
  // priced. The list carries both counts so nothing has to be opened to know.
  const ready = r => r.expenseCount > 0 && !r.unreviewed && !r.pendingRates;
  // A line still waiting for an exchange rate has no base amount, so it adds
  // nothing to the figure. Left unsaid, the tile quietly understates what is
  // open and nothing on the screen says why.
  const awaiting = open.some(r => r.pendingRates > 0) || unfiled.some(e => e.fxPending);

  const openEveryone = everyone.filter(r => r.status === 'open');
  const claimedEveryone = everyone.filter(r => r.status === 'claimed' && thisMonth(r.claimedAt));
  const stuck = everyone.filter(r => r.status === 'open' && r.pendingRates > 0);

  async function act(key, fn, done) {
    setBusy(key);
    try { await fn(); await load(); setChanged(n => n + 1); setMsg({ tone: 'success', text: done }); }
    catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(null); }
  }
  async function fileInto(expenseId, reportId) {
    if (!reportId) return;
    try {
      // The server answers 200 with a `skipped` list for anything it refused
      // (not reviewed, already in another case). Ignoring it made a refusal
      // look like a success and left the expense where it was.
      const r = await api.post(`/reports/${reportId}/expenses`, { expenseIds: [expenseId] });
      await load();
      const why = (r.skipped || []).find(s => s.id === expenseId);
      if (!why) setChanged(n => n + 1);
      setMsg(why ? { tone: 'warning', text: `Not filed: ${why.why}.` } : { tone: 'success', text: 'Filed into the case.' });
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const rowStyle = { display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: 13 };
  const num = { fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' };
  const muted = { fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' };

  // What a case row says about itself, in one phrase.
  const state = r => {
    if (r.pendingRates > 0) return { text: `${r.pendingRates} without a rate`, tone: 'var(--warning)' };
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
          <ReceiptUpload onUploaded={load} />
          <Link to="/reports" className="btn btn-outline">+ New case</Link>
        </div>
      </div>

      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}

      {isAdmin && (
        <div style={{ marginBottom: 24 }}>
          <div className="section-label">Everyone</div>
          <div className="grid-3" style={{ marginBottom: 14 }}>
            <div className="stat-card">
              <div className="stat-label">Open cases</div>
              <div className="stat-value">{openEveryone.length}</div>
              <div className="stat-sub">{openEveryone.length ? fmtMoney(sum(openEveryone.map(r => r.totalBase)), base) : 'nothing open'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Claimed this month</div>
              <div className="stat-value">{claimedEveryone.length}</div>
              <div className="stat-sub">{claimedEveryone.length ? fmtMoney(sum(claimedEveryone.map(r => r.totalBase)), base) : 'nothing yet'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Stuck</div>
              <div className="stat-value" style={stuck.length ? { color: 'var(--warning)' } : undefined}>{stuck.length}</div>
              <div className="stat-sub">{stuck.length ? 'waiting for an exchange rate' : 'nothing waiting'}</div>
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
          <div className="stat-value">{fmtMoney(sum(open.map(r => r.totalBase)), base)}</div>
          <div className="stat-sub" style={awaiting ? { color: 'var(--warning)' } : undefined}>
            {awaiting ? 'more is waiting for an exchange rate' : open.length ? `${open.length} case${open.length === 1 ? '' : 's'}` : 'nothing open'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Claimed this month</div>
          <div className="stat-value">{fmtMoney(sum(claimedThisMonth.map(r => r.totalBase)), base)}</div>
          <div className="stat-sub">{claimedThisMonth.length ? `${claimedThisMonth.length} case${claimedThisMonth.length === 1 ? '' : 's'}` : 'nothing yet'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Needs your check</div>
          <div className="stat-value">{needing.length}</div>
          <div className="stat-sub">{needing.length ? 'read by AI, waiting for you' : 'nothing to check'}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Open cases ({open.length})</div>
        <div className="card-subtitle">Receipts go in until you put the claim through; then mark it claimed here and it is done.</div>
        {!open.length ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No open cases. Add receipts above and one is made for them.</div> : open.map(r => {
          const s = state(r);
          return (
            <div key={r.id} style={{ ...rowStyle, flexWrap: 'wrap' }}>
              <span style={{ ...num, color: 'var(--text-muted)' }}>{r.number}</span>
              <Link to={`/reports/${r.id}`} style={{ flex: '1 1 160px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: 'inherit' }}>{r.title || 'Untitled'}</Link>
              <span style={muted}>{r.expenseCount} receipt{r.expenseCount === 1 ? '' : 's'}</span>
              <span style={num}>{fmtMoney(r.totalBase, base)}</span>
              <span style={{ ...muted, color: s.tone }}>{s.text}</span>
              {ready(r)
                ? <button className="btn btn-primary btn-sm" disabled={busy === r.id} onClick={() => act(r.id, () => api.post(`/reports/${r.id}/claimed`, {}), `${r.number} marked claimed.`)}>{busy === r.id ? 'Marking…' : 'Claimed'}</button>
                : <Link to={r.unreviewed > 0 ? `/reports/${r.id}/check` : `/reports/${r.id}`} className="btn btn-outline btn-sm">{r.unreviewed > 0 ? 'Check' : 'Open'}</Link>}
            </div>
          );
        })}
      </div>

      {unfiled.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">Checked, not in a case ({unfiled.length})</div>
          <div className="card-subtitle">Pick a case to file each one into.</div>
          {unfiled.map(e => (
            <div key={e.id} style={{ ...rowStyle, flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 140px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.receiptDate || '—'} · {e.merchant || 'Untitled'}</span>
              <span style={num}>{e.baseTotal != null ? fmtMoney(e.baseTotal, base) : fmtMoney(e.total, e.currency)}</span>
              <select className="form-input" style={{ flex: '1 1 150px', maxWidth: 200, padding: '4px 8px', fontSize: 12 }} defaultValue="" onChange={ev => fileInto(e.id, ev.target.value)} aria-label="File into case">
                <option value="">File into…</option>
                {open.map(r => <option key={r.id} value={r.id}>{r.number} {r.title || ''}</option>)}
              </select>
            </div>))}
        </div>
      )}

      <Insights refresh={changed} />

      <div className="card">
        <div className="card-title">Needs your check ({needing.length})</div>
        <div className="card-subtitle">Check the fields against the receipt, add the business purpose, then mark it reviewed.</div>
        <ExpenseTable expenses={needing} empty="Nothing waiting. Add a receipt above." />
      </div>
    </div>
  );
}
