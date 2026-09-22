import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import StatusBadge from '../components/StatusBadge';
import { fmtMoney } from '../utils/format';

// A report is a trip or a period: a cover, the expenses filed under it, and a
// state. The list is the claimant's own; managers can see their team's,
// finance everyone's.
// A case is the default: it is the one that asks nothing beyond a name, and it
// is what a bundle of receipts is. A trip wants a destination, a period wants
// its month.
const EMPTY = { title: '', purpose: '', kind: 'case', periodFrom: '', periodTo: '', destination: '' };
const KIND_LABEL = { case: 'Case', trip: 'Trip', period: 'Period' };

export default function Reports() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [scope, setScope] = useState('mine');
  const [reports, setReports] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState(null);
  const base = user?.baseCurrency || 'SGD';
  const canTeam = user?.role === 'manager';
  const canAll = user?.role === 'finance' || user?.role === 'admin';

  const load = useCallback(() => api.get(`/reports?scope=${scope}`).then(d => setReports(d.reports)).catch(e => setMsg({ tone: 'error', text: e.message })), [scope]);
  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    try { const d = await api.post('/reports', form); navigate(`/reports/${d.report.id}`); }
    catch (err) { setMsg({ tone: 'error', text: err.message }); }
  }
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>Reports</h1><p>File reviewed expenses into a report, submit it, and export it once approved.</p></div>
        <button className="btn btn-primary" onClick={() => setCreating(c => !c)}>{creating ? 'Close' : '+ New report'}</button>
      </div>
      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}

      {creating && (
        <form className="card" onSubmit={create} style={{ marginBottom: 18 }}>
          <div className="card-title">New report</div>
          <div className="card-subtitle">A trip has dates and a destination; a period is a month of local claims.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 12px' }}>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}><label className="form-label" htmlFor="r-title">Title</label><input id="r-title" className="form-input" required placeholder="India trip, Sep 2026" value={form.title} onChange={e => set('title', e.target.value)} /></div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}><label className="form-label" htmlFor="r-purpose">Purpose</label><input id="r-purpose" className="form-input" placeholder="Client site visits" value={form.purpose} onChange={e => set('purpose', e.target.value)} /></div>
            <div className="form-group"><label className="form-label" htmlFor="r-kind">Kind</label><select id="r-kind" className="form-input" value={form.kind} onChange={e => set('kind', e.target.value)}><option value="case">Case</option><option value="trip">Trip</option><option value="period">Period</option></select></div>
            <div className="form-group"><label className="form-label" htmlFor="r-from">From</label><input id="r-from" className="form-input" type="date" value={form.periodFrom} onChange={e => set('periodFrom', e.target.value)} /></div>
            <div className="form-group"><label className="form-label" htmlFor="r-to">To</label><input id="r-to" className="form-input" type="date" value={form.periodTo} onChange={e => set('periodTo', e.target.value)} /></div>
            {form.kind === 'trip' && <div className="form-group"><label className="form-label" htmlFor="r-dest">Destination</label><input id="r-dest" className="form-input" placeholder="Mumbai and Pune, India" value={form.destination} onChange={e => set('destination', e.target.value)} /></div>}
          </div>
          <button className="btn btn-primary" type="submit">Create report</button>
        </form>
      )}

      {(canTeam || canAll) && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {[['mine', 'Mine'], canTeam && ['team', 'My team'], canAll && ['all', 'Everyone']].filter(Boolean).map(([k, label]) => (
            <button key={k} className={`btn btn-sm ${scope === k ? 'btn-primary' : 'btn-outline'}`} onClick={() => setScope(k)}>{label}</button>
          ))}
        </div>
      )}

      <div className="card">
        {!reports.length ? <div style={{ padding: '22px 0', color: 'var(--text-muted)', fontSize: 13 }}>No reports yet. Create one, then file your reviewed expenses into it.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Number</th><th>Title</th>{scope !== 'mine' && <th>Claimant</th>}<th>Period</th><th style={{ textAlign: 'right' }}>Expenses</th><th style={{ textAlign: 'right' }}>{base}</th><th>Status</th></tr></thead>
              <tbody>{reports.map(r => (
                <tr key={r.id} onClick={() => navigate(`/reports/${r.id}`)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{r.number}</td>
                  <td><div style={{ fontWeight: 600 }}>{r.title || '—'} <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)' }}>{KIND_LABEL[r.kind] || ''}</span></div>{r.purpose && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{r.purpose}</div>}</td>
                  {scope !== 'mine' && <td>{r.ownerName || r.ownerEmail}</td>}
                  <td style={{ whiteSpace: 'nowrap' }}>{r.periodFrom || '—'}{r.periodTo ? ` – ${r.periodTo}` : ''}</td>
                  <td style={{ textAlign: 'right' }}>{r.expenseCount}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', color: r.pendingRates ? 'var(--warning)' : undefined }}>{fmtMoney(r.totalBase, base)}{r.pendingRates ? ' *' : ''}</td>
                  <td><StatusBadge status={r.status} /></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
