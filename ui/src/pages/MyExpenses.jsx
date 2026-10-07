import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import ReceiptUpload from '../components/receipts/ReceiptUpload';
import ExpenseTable from '../components/ExpenseTable';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { useOnChanged } from '../utils/useOnChanged';

const FILTERS = [['', 'All'], ['review-needed', 'Needs review'], ['reviewed', 'Reviewed'], ['duplicate', 'Duplicates']];

export default function MyExpenses() {
  const navigate = useNavigate();
  // null while the list for the chosen filter is on its way.
  const [expenses, setExpenses] = useState(null);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState(null);
  // Only the latest request may paint. Clicking through the filters quickly
  // let a slower, older answer land last, and the list under "Reviewed" was
  // then the one for "All".
  const latest = useRef(0);
  // Without the error, a failed request rendered the empty state, which says
  // "No receipts yet." — the one thing it definitely does not mean.
  const load = useCallback(() => {
    const asked = ++latest.current;
    return api.get(`/expenses${status ? `?status=${status}` : ''}`)
      .then(d => { if (asked === latest.current) { setExpenses(d.expenses); setErr(null); } })
      .catch(e => { if (asked === latest.current) setErr(e.message); });
  }, [status]);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, () => ((expenses || []).some(e => e.status === 'reading') ? 2500 : 30000));
  useOnChanged(load);
  const pick = k => { if (k === status) return; setExpenses(null); setStatus(k); };

  return (
    <div>
      {err && <div className="alert alert-error">Could not load your receipts: {err}</div>}
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>My receipts</h1><p>Every receipt you have recorded, newest first. Anything added here starts a case.</p></div>
        <ReceiptUpload onUploaded={load} onCase={c => navigate(`/reports/${c.id}`)} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {FILTERS.map(([k, label]) => (
          <button key={k} className={`btn btn-sm ${status === k ? 'btn-primary' : 'btn-outline'}`} onClick={() => pick(k)}>{label}</button>
        ))}
      </div>
      <div className="card"><ExpenseTable expenses={expenses} /></div>
    </div>
  );
}
