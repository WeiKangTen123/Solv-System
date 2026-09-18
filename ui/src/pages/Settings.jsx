import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog from '../components/ConfirmDialog';

const POLICIES = [['receipt_date', 'Rate on the receipt date'], ['submission_date', 'Rate on the submission date'], ['monthly_fixed', 'Monthly fixed table (finance enters rates)']];
const ROLES = ['employee', 'manager', 'finance', 'admin'];

export default function Settings() {
  const { user, refreshUser } = useAuth();
  const [company, setCompany] = useState(null);
  const [columns, setColumns] = useState('');
  const [users, setUsers] = useState([]);
  const [keys, setKeys] = useState([]);
  const [rates, setRates] = useState([]);
  const [xero, setXero] = useState(null);
  const [xeroForm, setXeroForm] = useState({ XERO_CLIENT_ID: '', XERO_CLIENT_SECRET: '', XERO_OAUTH_CLIENT_ID: '', XERO_OAUTH_CLIENT_SECRET: '', DEFAULT_ACCOUNT_CODE: '' });
  const [params, setParams] = useSearchParams();
  const [newRate, setNewRate] = useState({ from: '', date: new Date().toISOString().slice(0, 10), rate: '' });
  const [newUser, setNewUser] = useState({ email: '', password: '', name: '', role: 'employee', department: '', employeeId: '', managerId: '' });
  const [newKey, setNewKey] = useState({ apiKey: '', label: '' });
  const [msg, setMsg] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const isAdmin = user?.role === 'admin';

  async function loadAll() {
    const c = await api.get('/company'); setCompany(c.company); setColumns(c.company.reportColumns.join(', '));
    setUsers((await api.get('/users')).users);
    setKeys((await api.get('/company/llm-keys')).keys);
    setRates((await api.get('/fx/rates')).rates.slice(0, 30));
    const x = await api.get('/xero'); setXero(x);
    setXeroForm(f => ({ ...f, XERO_CLIENT_ID: x.fields.XERO_CLIENT_ID.value, XERO_OAUTH_CLIENT_ID: x.fields.XERO_OAUTH_CLIENT_ID.value, DEFAULT_ACCOUNT_CODE: x.fields.DEFAULT_ACCOUNT_CODE.value, XERO_CLIENT_SECRET: '', XERO_OAUTH_CLIENT_SECRET: '' }));
  }
  // Back from Xero's consent screen: finish the connection while signed in.
  useEffect(() => {
    if (params.get('xero_oauth') === 'pending' && params.get('code') && params.get('state')) {
      api.post('/xero/oauth/complete', { code: params.get('code'), state: params.get('state') })
        .then(() => { ok('Xero connected.'); return loadAll(); }).catch(fail).finally(() => setParams({}, { replace: true }));
    } else if (params.get('xero_oauth') === 'error') { fail(new Error('Xero did not complete the connection. Try again.')); setParams({}, { replace: true }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { loadAll().catch(e => setMsg({ tone: 'error', text: e.message })); }, []);
  const ok = text => setMsg({ tone: 'success', text });
  const fail = e => setMsg({ tone: 'error', text: e.message });

  async function saveCompany(e) {
    e.preventDefault();
    try {
      await api.patch('/company', { name: company.name, baseCurrency: company.baseCurrency.toUpperCase(), fxPolicy: company.fxPolicy, timezone: company.timezone,
                                     reportColumns: columns.split(',').map(s => s.trim()).filter(Boolean) });
      await loadAll(); await refreshUser(); ok('Company settings saved.');
    } catch (err) { fail(err); }
  }
  async function addUser(e) {
    e.preventDefault();
    try { await api.post('/users', { ...newUser, managerId: newUser.managerId || null }); setNewUser({ email: '', password: '', name: '', role: 'employee', department: '', employeeId: '', managerId: '' }); await loadAll(); ok('Staff member added.'); }
    catch (err) { fail(err); }
  }
  async function patchUser(id, patch) { try { await api.patch(`/users/${id}`, patch); await loadAll(); } catch (err) { fail(err); } }
  async function addRate(e) {
    e.preventDefault();
    try { await api.post('/fx/rates', { from: newRate.from.toUpperCase(), date: newRate.date, rate: Number(newRate.rate) }); setNewRate({ ...newRate, from: '', rate: '' }); await loadAll(); ok('Rate saved.'); } catch (err) { fail(err); }
  }
  async function saveXero(e) {
    e.preventDefault();
    try { await api.patch('/xero/credentials', xeroForm); await loadAll(); ok('Xero settings saved.'); } catch (err) { fail(err); }
  }
  async function testXero() {
    try { const r = await api.post('/xero/test', {}); await loadAll(); ok(`Connected: ${r.tenants.map(t => t.tenantName).join(', ')}`); } catch (err) { fail(err); }
  }
  async function connectXero() {
    try { const d = await api.get('/xero/oauth/connect'); window.location.href = d.url; } catch (err) { fail(err); }
  }
  async function addKey(e) {
    e.preventDefault();
    try { await api.post('/company/llm-keys', newKey); setNewKey({ apiKey: '', label: '' }); await loadAll(); ok('Reader key added.'); } catch (err) { fail(err); }
  }

  if (!company) return <div style={{ color: 'var(--text-muted)' }}>{msg?.text || 'Loading…'}</div>;
  const managers = users.filter(u => u.role === 'manager' || u.role === 'admin' || u.role === 'finance');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 900 }}>
      <div className="page-header"><h1>Settings</h1><p>Company, staff and the receipt reader.</p></div>
      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}

      <form className="card" onSubmit={saveCompany}>
        <div className="card-title">Company</div>
        <div className="card-subtitle">The base currency every report totals in, and how foreign amounts are converted.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 12px' }}>
          <div className="form-group"><label className="form-label" htmlFor="c-name">Name</label><input id="c-name" className="form-input" value={company.name} onChange={e => setCompany({ ...company, name: e.target.value })} /></div>
          <div className="form-group"><label className="form-label" htmlFor="c-ccy">Base currency</label><input id="c-ccy" className="form-input" value={company.baseCurrency} maxLength={3} onChange={e => setCompany({ ...company, baseCurrency: e.target.value })} /></div>
          <div className="form-group"><label className="form-label" htmlFor="c-tz">Timezone</label><input id="c-tz" className="form-input" value={company.timezone} onChange={e => setCompany({ ...company, timezone: e.target.value })} /></div>
          <div className="form-group"><label className="form-label" htmlFor="c-fx">Exchange-rate policy</label>
            <select id="c-fx" className="form-input" value={company.fxPolicy} onChange={e => setCompany({ ...company, fxPolicy: e.target.value })}>{POLICIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        </div>
        <div className="form-group"><label className="form-label" htmlFor="c-cols">Report columns (in order, comma separated)</label><input id="c-cols" className="form-input" value={columns} onChange={e => setColumns(e.target.value)} /></div>
        <button className="btn btn-primary" type="submit">Save company</button>
      </form>

      <div className="card">
        <div className="card-title">Staff</div>
        <div className="card-subtitle">Who can claim, who approves, who pays. A manager approves their direct reports.</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Role</th><th>Manager</th><th></th></tr></thead>
            <tbody>{users.map(u => (
              <tr key={u.id}>
                <td>{u.name || '—'}{u.employeeId ? <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.employeeId}</div> : null}</td>
                <td>{u.email}</td><td>{u.department || '—'}</td>
                <td>{isAdmin ? <select className="form-input" style={{ padding: '4px 8px' }} value={u.role} onChange={e => patchUser(u.id, { role: e.target.value })}>{ROLES.map(r => <option key={r}>{r}</option>)}</select> : u.role}</td>
                <td>{isAdmin ? <select className="form-input" style={{ padding: '4px 8px' }} value={u.managerId || ''} onChange={e => patchUser(u.id, { managerId: e.target.value || null })}><option value="">—</option>{managers.filter(m => m.id !== u.id).map(m => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}</select> : (managers.find(m => m.id === u.managerId)?.name || '—')}</td>
                <td>{isAdmin && u.id !== user.id && <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(u)}>Remove</button>}</td>
              </tr>))}</tbody>
          </table>
        </div>
        {isAdmin && (
          <form onSubmit={addUser} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 14, alignItems: 'end' }}>
            <input className="form-input" placeholder="Name" value={newUser.name} onChange={e => setNewUser({ ...newUser, name: e.target.value })} aria-label="Name" />
            <input className="form-input" placeholder="Email" type="email" required value={newUser.email} onChange={e => setNewUser({ ...newUser, email: e.target.value })} aria-label="Email" />
            <input className="form-input" placeholder="Password (8+)" type="password" required minLength={8} value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })} aria-label="Password" />
            <input className="form-input" placeholder="Department" value={newUser.department} onChange={e => setNewUser({ ...newUser, department: e.target.value })} aria-label="Department" />
            <input className="form-input" placeholder="Employee ID" value={newUser.employeeId} onChange={e => setNewUser({ ...newUser, employeeId: e.target.value })} aria-label="Employee ID" />
            <select className="form-input" value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value })} aria-label="Role">{ROLES.map(r => <option key={r}>{r}</option>)}</select>
            <select className="form-input" value={newUser.managerId} onChange={e => setNewUser({ ...newUser, managerId: e.target.value })} aria-label="Manager"><option value="">No manager</option>{managers.map(m => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}</select>
            <button className="btn btn-primary" type="submit">Add staff</button>
          </form>
        )}
      </div>

      {xero && (
        <form className="card" onSubmit={saveXero}>
          <div className="card-title">Xero</div>
          <div className="card-subtitle">Approved reports post to Xero as draft bills payable to the claimant. Connect with a Custom Connection (client id and secret) or with the OAuth web-app flow.</div>
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            {xero.tenants.length ? <span style={{ color: 'var(--success)' }}>Connected to {xero.tenants.map(t => t.tenantName).join(', ')} ({xero.connectionType || 'custom'})</span> : <span style={{ color: 'var(--text-muted)' }}>Not connected.</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 12px' }}>
            <div className="form-group"><label className="form-label" htmlFor="x-cid">Custom Connection client ID</label><input id="x-cid" className="form-input" value={xeroForm.XERO_CLIENT_ID} onChange={e => setXeroForm({ ...xeroForm, XERO_CLIENT_ID: e.target.value })} /></div>
            <div className="form-group"><label className="form-label" htmlFor="x-sec">Client secret {xero.fields.XERO_CLIENT_SECRET.isSet ? '(stored; blank keeps it)' : ''}</label><input id="x-sec" className="form-input" type="password" value={xeroForm.XERO_CLIENT_SECRET} onChange={e => setXeroForm({ ...xeroForm, XERO_CLIENT_SECRET: e.target.value })} /></div>
            <div className="form-group"><label className="form-label" htmlFor="x-ocid">OAuth web app client ID</label><input id="x-ocid" className="form-input" value={xeroForm.XERO_OAUTH_CLIENT_ID} onChange={e => setXeroForm({ ...xeroForm, XERO_OAUTH_CLIENT_ID: e.target.value })} /></div>
            <div className="form-group"><label className="form-label" htmlFor="x-osec">OAuth client secret {xero.fields.XERO_OAUTH_CLIENT_SECRET.isSet ? '(stored; blank keeps it)' : ''}</label><input id="x-osec" className="form-input" type="password" value={xeroForm.XERO_OAUTH_CLIENT_SECRET} onChange={e => setXeroForm({ ...xeroForm, XERO_OAUTH_CLIENT_SECRET: e.target.value })} /></div>
            <div className="form-group"><label className="form-label" htmlFor="x-acc">Default account code</label><input id="x-acc" className="form-input" placeholder="429" value={xeroForm.DEFAULT_ACCOUNT_CODE} onChange={e => setXeroForm({ ...xeroForm, DEFAULT_ACCOUNT_CODE: e.target.value })} /></div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" type="submit">Save Xero settings</button>
            <button className="btn btn-outline" type="button" onClick={testXero}>Test Custom Connection</button>
            <button className="btn btn-outline" type="button" onClick={connectXero} disabled={!xero.oauthRedirectConfigured} title={xero.oauthRedirectConfigured ? '' : 'Set XERO_OAUTH_REDIRECT_URI on the server first'}>Connect with Xero (OAuth)</button>
            {xero.tenants.length > 0 && <button className="btn btn-ghost" type="button" onClick={() => api.delete('/xero/oauth/disconnect').then(loadAll).catch(fail)}>Disconnect</button>}
          </div>
        </form>
      )}

      <div className="card">
        <div className="card-title">Exchange rates</div>
        <div className="card-subtitle">Rates used so far, newest first. A rate entered here beats the provider's for that day; use it for a monthly fixed table or a correction.</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Date</th><th>Pair</th><th style={{ textAlign: 'right' }}>Rate</th><th>Source</th><th></th></tr></thead>
            <tbody>{rates.map(r => (
              <tr key={`${r.from}-${r.to}-${r.rateDate}-${r.source}`}>
                <td>{r.rateDate}{r.providerDate && r.providerDate !== r.rateDate ? <span style={{ color: 'var(--text-muted)' }}> (priced {r.providerDate})</span> : null}</td>
                <td>{r.from} → {r.to}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.rate}</td>
                <td>{r.source}{r.enteredBy ? <span style={{ color: 'var(--text-muted)' }}> · {r.enteredBy}</span> : null}</td>
                <td>{r.source === 'manual' && <button className="btn btn-ghost btn-sm" onClick={() => api.delete(`/fx/rates?from=${r.from}&to=${r.to}&date=${r.rateDate}`).then(loadAll).catch(fail)}>Remove</button>}</td>
              </tr>))}</tbody>
          </table>
          {!rates.length && <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>No rates fetched yet.</div>}
        </div>
        <form onSubmit={addRate} style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input id="rate-from" className="form-input" style={{ maxWidth: 90 }} placeholder="INR" maxLength={3} required value={newRate.from} onChange={e => setNewRate({ ...newRate, from: e.target.value })} aria-label="From currency" />
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>→ {company.baseCurrency} on</span>
          <input id="rate-date" className="form-input" type="date" style={{ maxWidth: 170 }} required value={newRate.date} onChange={e => setNewRate({ ...newRate, date: e.target.value })} aria-label="Date" />
          <input id="rate-value" className="form-input" type="number" step="0.000001" min="0" style={{ maxWidth: 150 }} placeholder="0.01341" required value={newRate.rate} onChange={e => setNewRate({ ...newRate, rate: e.target.value })} aria-label="Rate" />
          <button className="btn btn-primary" type="submit">Save rate</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Receipt reader keys</div>
        <div className="card-subtitle">Gemini API keys, shared by the company. Keys rotate when one runs out of quota.</div>
        {keys.map(k => (
          <div key={k.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
            <span><code>{k.keyMasked}</code> {k.label && <span style={{ color: 'var(--text-muted)' }}>· {k.label}</span>}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => api.delete(`/company/llm-keys/${k.id}`).then(loadAll).catch(fail)}>Remove</button>
          </div>
        ))}
        <form onSubmit={addKey} style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input className="form-input" style={{ flex: 2, minWidth: 220 }} placeholder="AIza…" required value={newKey.apiKey} onChange={e => setNewKey({ ...newKey, apiKey: e.target.value })} aria-label="API key" />
          <input className="form-input" style={{ flex: 1, minWidth: 120 }} placeholder="Label" value={newKey.label} onChange={e => setNewKey({ ...newKey, label: e.target.value })} aria-label="Label" />
          <button className="btn btn-primary" type="submit">Add key</button>
        </form>
      </div>

      {confirm && <ConfirmDialog title={`Remove ${confirm.name || confirm.email}?`} message="Their expenses stay; they can no longer sign in." confirmLabel="Remove" danger
                                 onConfirm={() => api.delete(`/users/${confirm.id}`).then(() => { setConfirm(null); return loadAll(); }).catch(fail)} onCancel={() => setConfirm(null)} />}
    </div>
  );
}
