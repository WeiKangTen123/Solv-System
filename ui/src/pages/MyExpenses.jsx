import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import ReceiptUpload from '../components/receipts/ReceiptUpload';
import ExpenseTable from '../components/ExpenseTable';
import { useVisiblePolling } from '../utils/useVisiblePolling';

const FILTERS = [['', 'All'], ['review-needed', 'Needs review'], ['reviewed', 'Reviewed'], ['duplicate', 'Duplicates']];

export default function MyExpenses() {
  const [expenses, setExpenses] = useState([]);
  const [status, setStatus] = useState('');
  const load = useCallback(() => api.get(`/expenses${status ? `?status=${status}` : ''}`).then(d => setExpenses(d.expenses)).catch(() => {}), [status]);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, () => (expenses.some(e => e.status === 'reading') ? 2500 : 30000));

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>My expenses</h1><p>Every receipt you have added, newest first.</p></div>
        <ReceiptUpload onUploaded={load} />
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
