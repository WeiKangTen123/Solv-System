import { useNavigate } from 'react-router-dom';
import StatusBadge from './StatusBadge';
import { fmtMoney } from '../utils/format';

// One table for Home and My expenses. A row is the receipt as read: date,
// merchant, original amount, category, state. Click to review.
export default function ExpenseTable({ expenses, empty = 'No expenses yet.' }) {
  const navigate = useNavigate();
  if (!expenses.length) return <div style={{ padding: '22px 0', color: 'var(--text-muted)', fontSize: 13 }}>{empty}</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <thead><tr><th>Date</th><th>Merchant</th><th style={{ textAlign: 'right' }}>Amount</th><th>Category</th><th>Status</th></tr></thead>
        <tbody>
          {expenses.map(e => (
            <tr key={e.id} onClick={() => navigate(`/expenses/${e.id}`)} style={{ cursor: 'pointer' }}>
              <td style={{ whiteSpace: 'nowrap' }}>{e.receiptDate || '—'}</td>
              <td>
                <div style={{ fontWeight: 600 }}>{e.merchant || (e.status === 'reading' ? 'Reading the receipt…' : 'Untitled receipt')}</div>
                {e.errorMsg && <div style={{ fontSize: 11.5, color: 'var(--warning)' }}>{e.errorMsg}</div>}
                {e.purpose && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.purpose}</div>}
              </td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{e.total ? fmtMoney(e.total, e.currency) : '—'}</td>
              <td>{e.lines.length > 1 ? `${e.lines.length} lines` : (e.lines[0]?.category || e.category || '—')}</td>
              <td><StatusBadge status={e.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
