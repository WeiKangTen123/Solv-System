import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import StatusBadge from '../components/StatusBadge';
import { fmtMoney } from '../utils/format';
import { unpricedCount, unpricedText } from '../utils/caseTotals';
import { useOnChanged } from '../utils/useOnChanged';

// A case is a bundle of receipts claimed as one thing: a cover, the receipts
// filed under it, open or claimed. The list is the claimant's own; an admin can
// see everyone's.
// A case is the default: it is the one that asks nothing beyond a name, and it
// is what a bundle of receipts is. A trip wants a destination, a period wants
// its month.
const EMPTY = { title: '', purpose: '', kind: 'case', periodFrom: '', periodTo: '', destination: '' };
const KIND_LABEL = { case: 'Case', trip: 'Trip', period: 'Period' };

export default function Reports() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [scope, setScope] = useState('mine');
  // null until the list arrives: "No cases yet" is an answer, not a wait.
  const [reports, setReports] = useState(null);
  const [form, setForm] = useState(EMPTY);
  // "+ New case" on Home comes here as ?new=1 and lands on the open form.
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(() => params.get('new') === '1');
  const [msg, setMsg] = useState(null);
  const base = user?.baseCurrency || 'SGD';
  const canAll = user?.role === 'admin';

  // Read once, then taken out of the address, so a reload or the back button
  // does not open the form again after it was closed.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setCreating(true);
    const rest = new URLSearchParams(params);
    rest.delete('new');
    setParams(rest, { replace: true });
  }, [params, setParams]);

  const load = useCallback(() => api.get(`/reports?scope=${scope}`).then(d => setReports(d.reports)).catch(e => setMsg({ tone: 'error', text: e.message })), [scope]);
  useEffect(() => { load(); }, [load]);
  useOnChanged(load);

  const [saving, setSaving] = useState(false);
  async function create(e) {
    e.preventDefault();
    // A double click made two cases.
    if (saving) return;
    setSaving(true);
    try { const d = await api.post('/reports', form); navigate(`/reports/${d.report.id}`); }
    catch (err) { setMsg({ tone: 'error', text: err.message }); setSaving(false); }
  }
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>Cases</h1><p>A case is a bundle of receipts claimed as one thing. Open while receipts go in, claimed once you have put it through.</p></div>
        <button className="btn btn-primary" onClick={() => setCreating(c => !c)}>{creating ? 'Close' : '+ New case'}</button>
      </div>
      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}

      {creating && (
        <form className="card" onSubmit={create} style={{ marginBottom: 18 }}>
          <div className="card-title">New case</div>
          <div className="card-subtitle">A trip has dates and a destination; a period is a month of local claims.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 12px' }}>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}><label className="form-label" htmlFor="r-title">Title</label><input id="r-title" className="form-input" required autoFocus placeholder="India trip, Sep 2026" value={form.title} onChange={e => set('title', e.target.value)} /></div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}><label className="form-label" htmlFor="r-purpose">Purpose</label><input id="r-purpose" className="form-input" placeholder="Client site visits" value={form.purpose} onChange={e => set('purpose', e.target.value)} /></div>
            <div className="form-group"><label className="form-label" htmlFor="r-kind">Kind</label><select id="r-kind" className="form-input" value={form.kind} onChange={e => set('kind', e.target.value)}><option value="case">Case</option><option value="trip">Trip</option><option value="period">Period</option></select></div>
            <div className="form-group"><label className="form-label" htmlFor="r-from">From</label><input id="r-from" className="form-input" type="date" value={form.periodFrom} onChange={e => set('periodFrom', e.target.value)} /></div>
            <div className="form-group"><label className="form-label" htmlFor="r-to">To</label><input id="r-to" className="form-input" type="date" value={form.periodTo} onChange={e => set('periodTo', e.target.value)} /></div>
            {form.kind === 'trip' && <div className="form-group"><label className="form-label" htmlFor="r-dest">Destination</label><input id="r-dest" className="form-input" placeholder="Mumbai and Pune, India" value={form.destination} onChange={e => set('destination', e.target.value)} /></div>}
          </div>
          <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create case'}</button>
        </form>
      )}

      {canAll && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {[['mine', 'Mine'], ['all', 'Everyone']].map(([k, label]) => (
            <button key={k} className={`btn btn-sm ${scope === k ? 'btn-primary' : 'btn-outline'}`} onClick={() => { if (k !== scope) { setReports(null); setScope(k); } }}>{label}</button>
          ))}
        </div>
      )}

      <div className="card">
        {!reports ? <div style={{ padding: '22px 0', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
          : !reports.length ? <div style={{ padding: '22px 0', color: 'var(--text-muted)', fontSize: 13 }}>No cases yet. Add receipts on Home and a case is made for them, or create one here and add to it.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Number</th><th>Title</th>{scope !== 'mine' && <th>Claimant</th>}<th>Period</th><th style={{ textAlign: 'right' }}>Receipts</th><th style={{ textAlign: 'right' }}>{base}</th><th>Status</th></tr></thead>
              <tbody>{reports.map(r => (
                <tr key={r.id} onClick={() => navigate(`/reports/${r.id}`)} style={{ cursor: 'pointer' }}
                    tabIndex={0} role="link" aria-label={`Open case ${r.number}`}
                    onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); navigate(`/reports/${r.id}`); } }}>
                  <td style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{r.number}</td>
                  <td><div style={{ fontWeight: 600 }}>{r.title || '—'} <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)' }}>{KIND_LABEL[r.kind] || ''}</span></div>{r.purpose && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{r.purpose}</div>}</td>
                  {scope !== 'mine' && <td>{r.ownerName || r.ownerEmail}</td>}
                  <td style={{ whiteSpace: 'nowrap' }}>{r.periodFrom || '—'}{r.periodTo ? ` – ${r.periodTo}` : ''}</td>
                  <td style={{ textAlign: 'right' }}>{r.expenseCount}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', color: unpricedCount(r) ? 'var(--warning)' : undefined }}
                      title={unpricedCount(r) ? `Not counted: ${unpricedText(r)}` : undefined}>{fmtMoney(r.totalBase, base)}{unpricedCount(r) ? ' *' : ''}</td>
                  <td><StatusBadge status={r.status} /></td>
                </tr>))}</tbody>
            </table>
            {/* The star said nothing about itself. */}
            {reports.some(r => unpricedCount(r)) && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
                * Short of the full amount: some receipts have no amount or exchange rate yet. Open the case to see which.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
