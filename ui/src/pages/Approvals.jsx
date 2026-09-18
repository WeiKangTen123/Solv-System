import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import StatusBadge from '../components/StatusBadge';
import { fmtMoney } from '../utils/format';
import { formatRelative } from '../utils/formatDate';
import { useVisiblePolling } from '../utils/useVisiblePolling';

// What is waiting on this person: a manager sees direct reports' submitted
// reports; finance sees everything submitted or approved and not yet paid.
export default function Approvals() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [reports, setReports] = useState([]);
  const base = user?.baseCurrency || 'SGD';
  const load = useCallback(() => api.get('/reports/queue').then(d => setReports(d.reports)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, 30000);

  return (
    <div>
      <div className="page-header"><h1>Approvals</h1><p>{user?.role === 'manager' ? 'Reports from your team waiting for your decision.' : 'Submitted reports to approve, and approved reports to pay.'}</p></div>
      <div className="card">
        {!reports.length ? <div style={{ padding: '22px 0', color: 'var(--text-muted)', fontSize: 13 }}>Nothing waiting.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Number</th><th>Claimant</th><th>Title</th><th style={{ textAlign: 'right' }}>{base}</th><th>Status</th><th>Submitted</th></tr></thead>
              <tbody>{reports.map(r => (
                <tr key={r.id} onClick={() => navigate(`/reports/${r.id}`)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{r.number}</td>
                  <td>{r.ownerName || r.ownerEmail}</td>
                  <td>{r.title || '—'}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>{fmtMoney(r.totalBase, base)}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td style={{ color: 'var(--text-muted)' }}>{formatRelative(r.submittedAt)}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
