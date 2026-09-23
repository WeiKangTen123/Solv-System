import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import ReceiptUpload from '../components/receipts/ReceiptUpload';
import ExpenseTable from '../components/ExpenseTable';
import { useVisiblePolling } from '../utils/useVisiblePolling';

const FILTERS = [['', 'All'], ['review-needed', 'Needs review'], ['reviewed', 'Reviewed'], ['duplicate', 'Duplicates']];

export default function MyExpenses() {
  const navigate = useNavigate();
  const [expenses, setExpenses] = useState([]);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState(null);
  // Without this a failed request rendered the empty state, which says
  // "No expenses yet." — the one thing it definitely does not mean.
  const load = useCallback(() => api.get(`/expenses${status ? `?status=${status}` : ''}`)
    .then(d => { setExpenses(d.expenses); setErr(null); })
    .catch(e => setErr(e.message)), [status]);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, () => (expenses.some(e => e.status === 'reading') ? 2500 : 30000));

  return (
    <div>
      {err && <div className="alert alert-error">Could not load your receipts: {err}</div>}
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>My receipts</h1><p>Every receipt you have recorded, newest first. Anything added here starts a case.</p></div>
        <ReceiptUpload onUploaded={load} onCase={c => navigate(`/reports/${c.id}`)} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {FILTERS.map(([k, label]) => (
          <button key={k} className={`btn btn-sm ${status === k ? 'btn-primary' : 'btn-outline'}`} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>
      <div className="card"><ExpenseTable expenses={expenses} /></div>
    </div>
  );
}
