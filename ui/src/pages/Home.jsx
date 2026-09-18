import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import ReceiptUpload from '../components/receipts/ReceiptUpload';
import ExpenseTable from '../components/ExpenseTable';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { Link } from 'react-router-dom';
import StatusBadge from '../components/StatusBadge';
import { fmtMoney } from '../utils/format';

// The front door: the three ways in, then what needs the person's attention.
export default function Home() {
  const { user } = useAuth();
  const [expenses, setExpenses] = useState([]);
  const [reports, setReports] = useState([]);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => Promise.all([
    api.get('/expenses').then(d => setExpenses(d.expenses)),
    api.get('/reports').then(d => setReports(d.reports)),
  ]).then(() => setMsg(m => (m && m.tone === 'error' ? null : m)))
    // Swallowing this rendered an empty home page, which reads as "you have no
    // expenses" rather than "the list could not be loaded".
    .catch(e => setMsg({ tone: 'error', text: `Could not load your expenses: ${e.message}` })), []);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, () => (expenses.some(e => e.status === 'reading') ? 2500 : 20000));

  const needing = expenses.filter(e => e.status === 'review-needed' || e.status === 'reading');
  const reviewed = expenses.filter(e => e.status === 'reviewed');
  const unfiled = reviewed.filter(e => !e.reportId);
  const open = reports.filter(r => ['draft', 'rejected', 'submitted'].includes(r.status));
  const drafts = reports.filter(r => ['draft', 'rejected'].includes(r.status));
  const base = user?.baseCurrency || 'SGD';
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

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>{greeting}, {user?.name || user?.email}</h1>
          <p>Add a receipt and the reader fills in the merchant, date, amount and category.</p>
        </div>
        <ReceiptUpload onUploaded={load} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 24 }}>
        <div className="stat-card"><div className="stat-label">Needs review</div><div className="stat-value">{needing.length}</div><div className="stat-sub">read by AI, waiting for you</div></div>
        <div className="stat-card"><div className="stat-label">Reviewed</div><div className="stat-value">{reviewed.length}</div><div className="stat-sub">ready for a report</div></div>
        <div className="stat-card"><div className="stat-label">All expenses</div><div className="stat-value">{expenses.length}</div><div className="stat-sub">{user?.baseCurrency || 'SGD'} base currency</div></div>
      </div>

      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 20 }}>
        <div className="card">
          <div className="card-title">Reviewed, not yet in a report ({unfiled.length})</div>
          <div className="card-subtitle">Pick a report to file each one into, or <Link to="/reports">create a report</Link>.</div>
          {!unfiled.length ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nothing waiting to be filed.</div> : unfiled.map(e => (
            <div key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.receiptDate || '—'} · {e.merchant || 'Untitled'}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{e.baseTotal != null ? fmtMoney(e.baseTotal, base) : fmtMoney(e.total, e.currency)}</span>
              <select className="form-input" style={{ width: 170, padding: '4px 8px', fontSize: 12 }} defaultValue="" onChange={ev => fileInto(e.id, ev.target.value)} aria-label="File into report">
                <option value="">File into…</option>
                {drafts.map(r => <option key={r.id} value={r.id}>{r.number} {r.title || ''}</option>)}
              </select>
            </div>))}
        </div>
        <div className="card">
          <div className="card-title">Open reports ({open.length})</div>
          <div className="card-subtitle">Drafts to finish, and submitted ones waiting for a decision.</div>
          {!open.length ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No open reports.</div> : open.map(r => (
            <Link key={r.id} to={`/reports/${r.id}`} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 13, color: 'inherit', textDecoration: 'none' }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{r.number}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{r.title || 'Untitled'}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>{fmtMoney(r.totalBase, base)}</span>
              <StatusBadge status={r.status} />
            </Link>))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Needs your attention</div>
        <div className="card-subtitle">Check the fields against the receipt, add the business purpose, then mark it reviewed.</div>
        <ExpenseTable expenses={needing} empty="Nothing waiting. Add a receipt above." />
      </div>
    </div>
  );
}
