import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import ReceiptUpload from '../components/receipts/ReceiptUpload';
import ExpenseTable from '../components/ExpenseTable';
import { useVisiblePolling } from '../utils/useVisiblePolling';

// The front door: the three ways in, then what needs the person's attention.
export default function Home() {
  const { user } = useAuth();
  const [expenses, setExpenses] = useState([]);
  const load = useCallback(() => api.get('/expenses').then(d => setExpenses(d.expenses)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, () => (expenses.some(e => e.status === 'reading') ? 2500 : 20000));

  const needing = expenses.filter(e => e.status === 'review-needed' || e.status === 'reading');
  const reviewed = expenses.filter(e => e.status === 'reviewed');
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

      <div className="card">
        <div className="card-title">Needs your attention</div>
        <div className="card-subtitle">Check the fields against the receipt, add the business purpose, then mark it reviewed.</div>
        <ExpenseTable expenses={needing} empty="Nothing waiting. Add a receipt above." />
      </div>
    </div>
  );
}
