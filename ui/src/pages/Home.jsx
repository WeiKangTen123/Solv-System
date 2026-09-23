import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import ReceiptUpload from '../components/receipts/ReceiptUpload';
import ExpenseTable from '../components/ExpenseTable';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { Link } from 'react-router-dom';
import StatusBadge from '../components/StatusBadge';
import { fmtMoney } from '../utils/format';

// Whole days since an ISO timestamp. What a queue is really asking is not how
// many reports are in it but how long the oldest one has been there.
function daysSince(iso) {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return Number.isFinite(d) && d >= 0 ? d : null;
}
const STALE = 5;   // days after which waiting stops being normal and starts being a problem
// Two labels, because they read in different places. `label` is a bare
// duration for a column of them; `ago` is a sentence fragment, and "today ago"
// is what you get from using the first where the second belongs.
function age(iso) {
  const d = daysSince(iso);
  if (d === null) return null;
  return {
    d,
    label: d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`,
    ago: d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`,
    stale: d >= STALE,
  };
}

// The front door. It answers "what should I do now", which is a different
// question for a claimant and for whoever decides on their claims — so the
// blocks are chosen by what the person actually has waiting, not by role name.
export default function Home() {
  const { user } = useAuth();
  const [expenses, setExpenses] = useState([]);
  const [reports, setReports] = useState([]);
  const [queue, setQueue] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => Promise.all([
    api.get('/expenses').then(d => setExpenses(d.expenses)),
    api.get('/reports').then(d => setReports(d.reports)),
    // Answers an empty list for anyone with nothing to decide, so it is asked
    // for everybody rather than branching on role in two places.
    api.get('/reports/queue').then(d => setQueue(d.reports || [])).catch(() => setQueue([])),
  ]).then(() => setMsg(m => (m && m.tone === 'error' ? null : m)))
    // Swallowing this rendered an empty home page, which reads as "you have no
    // expenses" rather than "the list could not be loaded".
    .catch(e => setMsg({ tone: 'error', text: `Could not load your expenses: ${e.message}` })), []);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, () => (expenses.some(e => e.status === 'reading') ? 2500 : 20000));

  const base = user?.baseCurrency || 'SGD';
  const needing = expenses.filter(e => e.status === 'review-needed' || e.status === 'reading');
  const unfiled = expenses.filter(e => e.status === 'reviewed' && !e.reportId);
  const drafts = reports.filter(r => ['draft', 'rejected'].includes(r.status));
  const open = reports.filter(r => ['draft', 'rejected', 'submitted'].includes(r.status));
  const toClaimReports = reports.filter(r => r.status === 'approved');
  const withManager = reports.filter(r => r.status === 'submitted');

  const sum = ns => Math.round(ns.reduce((s, n) => s + (Number(n) || 0), 0) * 100) / 100;
  // Approved and not yet claimed is the money that is actually waiting on this
  // person to do something. Drafts are not: nobody has agreed to them yet.
  const readyToClaim = sum(toClaimReports.map(r => r.totalBase));
  const withManagerTotal = sum(withManager.map(r => r.totalBase));
  const recorded = sum([...unfiled.map(e => e.baseTotal), ...drafts.map(r => r.totalBase)]);
  // A line still waiting for an exchange rate has no base amount, so it adds
  // nothing to either figure. Left unsaid, the tile quietly understates what is
  // recorded and nothing on the screen says why. Not a count: one side of this
  // knows about unpriced expenses and the other about unpriced lines, and
  // adding them would print a number that means neither.
  const awaiting = unfiled.some(e => e.fxPending) || drafts.some(r => r.pendingRates > 0);

  // What is waiting on this person to decide. Finance's queue also carries
  // approved reports, which are theirs to post to Xero, not to approve again.
  const canPost = user?.role === 'finance' || user?.role === 'admin';
  const toDecide = queue.filter(r => r.status === 'submitted');
  const toPost = queue.filter(r => r.status === 'approved');
  const queueTotal = sum(toDecide.map(r => r.totalBase));
  const oldest = toDecide.map(r => age(r.submittedAt)).filter(Boolean).sort((a, b) => b.d - a.d)[0] || null;
  const oldestReport = oldest ? toDecide.find(r => daysSince(r.submittedAt) === oldest.d) : null;

  async function act(key, fn, done) {
    setBusy(key);
    try { await fn(); await load(); setMsg({ tone: 'success', text: done }); }
    catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(null); }
  }
  async function fileInto(expenseId, reportId) {
    if (!reportId) return;
    try {
      // The server answers 200 with a `skipped` list for anything it refused
      // (not reviewed, already in another report). Ignoring it made a refusal
      // look like a success and left the expense where it was.
      const r = await api.post(`/reports/${reportId}/expenses`, { expenseIds: [expenseId] });
      await load();
      const why = (r.skipped || []).find(s => s.id === expenseId);
      setMsg(why ? { tone: 'warning', text: `Not filed: ${why.why}.` } : { tone: 'success', text: 'Filed into the report.' });
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const rowStyle = { display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: 13 };
  const num = { fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>{greeting}, {user?.name || user?.email}</h1>
          <p>Add a receipt and the reader fills in the merchant, date, amount and category.</p>
        </div>
        <ReceiptUpload onUploaded={load} />
      </div>

      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}

      {/* Whoever has claims waiting on them sees that first. Their own money is
          below it: a manager opening this page is here to unblock other people. */}
      {queue.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="section-label">Waiting on you</div>
          <div className={canPost ? 'grid-3' : 'grid-2'} style={{ marginBottom: 14 }}>
            <div className="stat-card">
              <div className="stat-label">To approve</div>
              <div className="stat-value">{toDecide.length}</div>
              <div className="stat-sub">{toDecide.length ? fmtMoney(queueTotal, base) : 'nothing submitted'}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Longest wait</div>
              <div className="stat-value" style={oldest?.stale ? { color: 'var(--warning)' } : undefined}>{oldest ? oldest.label : '—'}</div>
              <div className="stat-sub">{oldestReport ? `${oldestReport.number} · ${oldestReport.ownerName || ''}` : 'nothing waiting'}</div>
            </div>
            {/* Posting to Xero is finance's, so nobody else is shown a count of it. */}
            {canPost && (
              <div className="stat-card">
                <div className="stat-label">Approved, to post</div>
                <div className="stat-value">{toPost.length}</div>
                <div className="stat-sub">{toPost.length ? 'ready for Xero' : 'nothing to post'}</div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title">To approve ({toDecide.length})</div>
            <div className="card-subtitle">Open one to see the receipts, then approve it or send it back with a reason.</div>
            {!toDecide.length ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nothing is waiting on you.</div> : toDecide.map(r => {
              const a = age(r.submittedAt);
              return (
                <Link key={r.id} to={`/reports/${r.id}`} style={{ ...rowStyle, color: 'inherit', textDecoration: 'none' }}>
                  <span style={{ ...num, color: 'var(--text-muted)' }}>{r.number}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{r.ownerName || r.ownerEmail} · {r.title || 'Untitled'}</span>
                  <span style={num}>{fmtMoney(r.totalBase, base)}</span>
                  {a && <span style={{ ...num, fontSize: 11.5, color: a.stale ? 'var(--warning)' : 'var(--text-muted)' }}>{a.label}</span>}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {queue.length > 0 && <div className="section-label">Your own claims</div>}
      <div className="grid-3" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Ready to claim</div>
          <div className="stat-value">{fmtMoney(readyToClaim, base)}</div>
          <div className="stat-sub">{toClaimReports.length ? `approved · ${toClaimReports.length} report${toClaimReports.length > 1 ? 's' : ''}` : 'nothing approved yet'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">With your manager</div>
          <div className="stat-value">{fmtMoney(withManagerTotal, base)}</div>
          <div className="stat-sub">{withManager.length ? `submitted ${age(withManager.map(r => r.submittedAt).sort()[0])?.ago || ''}` : 'nothing submitted'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Recorded, not sent</div>
          <div className="stat-value">{fmtMoney(recorded, base)}</div>
          <div className="stat-sub" style={awaiting ? { color: 'var(--warning)' } : undefined}>
            {awaiting ? 'more is waiting for an exchange rate' : unfiled.length + drafts.length ? `${unfiled.length + drafts.length} to finish` : 'nothing waiting'}
          </div>
        </div>
      </div>

      {/* The one thing on this page that is purely the claimant's to do. */}
      {toClaimReports.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">Approved, not yet claimed ({toClaimReports.length})</div>
          <div className="card-subtitle">Put it through however your company reimburses you, then mark it claimed so it stops showing here.</div>
          {toClaimReports.map(r => {
            const a = age(r.approvedAt);
            return (
              <div key={r.id} style={{ ...rowStyle, flexWrap: 'wrap' }}>
                <span style={{ ...num, color: 'var(--text-muted)' }}>{r.number}</span>
                <Link to={`/reports/${r.id}`} style={{ flex: '1 1 140px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: 'inherit' }}>{r.title || 'Untitled'}</Link>
                <span style={num}>{fmtMoney(r.totalBase, base)}</span>
                {a && <span style={{ ...num, fontSize: 11.5, color: 'var(--text-muted)' }}>approved {a.ago}</span>}
                <button className="btn btn-primary btn-sm" disabled={busy === r.id}
                        onClick={() => act(r.id, () => api.post(`/reports/${r.id}/claimed`, {}), `${r.number} marked claimed.`)}>
                  {busy === r.id ? 'Marking…' : 'I have claimed this'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-title">Reviewed, not yet in a report ({unfiled.length})</div>
          <div className="card-subtitle">Pick a report to file each one into, or <Link to="/reports">create a report</Link>.</div>
          {/* The row wraps rather than clips: the fixed-width select and the
              merchant name together need more than a phone has, and the select
              was the half that fell off the edge. */}
          {!unfiled.length ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nothing waiting to be filed.</div> : unfiled.map(e => (
            <div key={e.id} style={{ ...rowStyle, flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 140px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.receiptDate || '—'} · {e.merchant || 'Untitled'}</span>
              <span style={num}>{e.baseTotal != null ? fmtMoney(e.baseTotal, base) : fmtMoney(e.total, e.currency)}</span>
              <select className="form-input" style={{ flex: '1 1 150px', maxWidth: 200, padding: '4px 8px', fontSize: 12 }} defaultValue="" onChange={ev => fileInto(e.id, ev.target.value)} aria-label="File into report">
                <option value="">File into…</option>
                {drafts.map(r => <option key={r.id} value={r.id}>{r.number} {r.title || ''}</option>)}
              </select>
            </div>))}
        </div>
        <div className="card">
          <div className="card-title">Open reports ({open.length})</div>
          <div className="card-subtitle">Drafts to finish, and submitted ones waiting for a decision.</div>
          {!open.length ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No open reports.</div> : open.map(r => (
            <Link key={r.id} to={`/reports/${r.id}`} style={{ ...rowStyle, color: 'inherit', textDecoration: 'none' }}>
              <span style={{ ...num, color: 'var(--text-muted)' }}>{r.number}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{r.title || 'Untitled'}</span>
              <span style={num}>{fmtMoney(r.totalBase, base)}</span>
              <StatusBadge status={r.status} />
            </Link>))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Needs your check ({needing.length})</div>
        <div className="card-subtitle">Check the fields against the receipt, add the business purpose, then mark it reviewed.</div>
        <ExpenseTable expenses={needing} empty="Nothing waiting. Add a receipt above." />
      </div>
    </div>
  );
}
