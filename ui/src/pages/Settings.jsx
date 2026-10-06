import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { formatRelative } from '../utils/formatDate';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';
import ExchangeRates from '../components/settings/ExchangeRates';

// What the reader last saw from a key: worked, ran out of quota, or was
// refused. Whichever happened most recently is the one that describes it.
function keyStatus(k) {
  const okAt = k.lastOkAt ? Date.parse(k.lastOkAt) : 0;
  const errAt = k.lastErrorAt ? Date.parse(k.lastErrorAt) : 0;
  if (!okAt && !errAt) return { color: 'var(--text-muted)', text: 'Not used yet' };
  if (okAt >= errAt) return { color: 'var(--success)', text: `Worked ${formatRelative(k.lastOkAt)}${k.lastModel ? ` · ${k.lastModel}` : ''}` };
  return { color: /quota|rate-limit/i.test(k.lastError || '') ? 'var(--warning)' : 'var(--danger)', text: `${k.lastError || 'Failed'} · ${formatRelative(k.lastErrorAt)}` };
}

const POLICIES = [
  ['receipt_date', 'Rate on the receipt date'],
  ['submission_date', 'Rate on the submission date'],
  ['monthly_fixed', 'Monthly fixed table (an admin enters rates)']
];
const ROLES = ['user', 'admin'];

const ADMIN_TABS = [
  { key: 'monitoring', label: 'Users & Monitoring', icon: '📊' },
  { key: 'profile',    label: 'My Profile & Security', icon: '👤' },
  { key: 'company',    label: 'Company & Policy',   icon: '🏢' },
  { key: 'xero',       label: 'Xero Integration',   icon: '⚡' },
  { key: 'keys',       label: 'LLM API Setup',      icon: '🔑' },
  { key: 'fx',         label: 'Exchange Rates',     icon: '💱' },
];

export default function Settings() {
  const { user, refreshUser } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const [adminTab, setAdminTab] = useState('monitoring');
  const [nameInput, setNameInput] = useState('');
  const [company, setCompany] = useState(null);
  const [columns, setColumns] = useState('');
  const [users, setUsers] = useState([]);
  const [keys, setKeys] = useState([]);
  const [keysMeta, setKeysMeta] = useState({ models: [], fallbackKey: false });
  const [keyTests, setKeyTests] = useState({});     // key id -> { busy } or { tone, text }
  const [xero, setXero] = useState(null);
  const [xeroForm, setXeroForm] = useState({ XERO_CLIENT_ID: '', XERO_CLIENT_SECRET: '', XERO_OAUTH_CLIENT_ID: '', XERO_OAUTH_CLIENT_SECRET: '', DEFAULT_ACCOUNT_CODE: '' });
  const [params, setParams] = useSearchParams();
  const [newKey, setNewKey] = useState({ apiKey: '', label: '' });
  const [currencies, setCurrencies] = useState([]);
  const [msg, setMsg] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [pwFor, setPwFor] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newPerson, setNewPerson] = useState({ email: '', name: '', password: '', role: 'user' });
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    if (user?.name) setNameInput(user.name);
  }, [user?.name]);

  async function loadAll() {
    const c = await api.get('/company');
    setCompany(c.company);
    setColumns(c.company.reportColumns.join(', '));
    setCurrencies(c.currencies || []);
    if (isAdmin) {
      setUsers((await api.get('/users')).users);
      await loadKeys();
      const x = await api.get('/xero');
      setXero(x);
      setXeroForm(f => ({
        ...f,
        XERO_CLIENT_ID: x.fields.XERO_CLIENT_ID.value,
        XERO_OAUTH_CLIENT_ID: x.fields.XERO_OAUTH_CLIENT_ID.value,
        DEFAULT_ACCOUNT_CODE: x.fields.DEFAULT_ACCOUNT_CODE.value,
        XERO_CLIENT_SECRET: '',
        XERO_OAUTH_CLIENT_SECRET: ''
      }));
    }
  }

  // Back from Xero's consent screen: finish the connection while signed in.
  useEffect(() => {
    if (params.get('xero_oauth') === 'pending' && params.get('code') && params.get('state')) {
      api.post('/xero/oauth/complete', { code: params.get('code'), state: params.get('state') })
        .then(() => { ok('Xero connected.'); return loadAll(); }).catch(fail).finally(() => setParams({}, { replace: true }));
    } else if (params.get('xero_oauth') === 'error') {
      fail(new Error('Xero did not complete the connection. Try again.'));
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadAll().catch(e => setMsg({ tone: 'error', text: e.message }));
  }, [isAdmin]);

  const ok = text => setMsg({ tone: 'success', text });
  const fail = e => setMsg({ tone: 'error', text: e.message });

  async function saveProfile(e) {
    e.preventDefault();
    try {
      await api.patch(`/users/${user.id}`, { name: nameInput.trim() });
      await refreshUser();
      ok('Profile name updated.');
    } catch (err) { fail(err); }
  }

  async function saveCompany(e) {
    e.preventDefault();
    try {
      await api.patch('/company', {
        name: company.name,
        baseCurrency: company.baseCurrency.toUpperCase(),
        fxPolicy: company.fxPolicy,
        timezone: company.timezone,
        reportColumns: columns.split(',').map(s => s.trim()).filter(Boolean),
        allowRegistration: !!company.allowRegistration,
      });
      await loadAll();
      await refreshUser();
      ok('Company settings saved.');
    } catch (err) { fail(err); }
  }

  async function addPerson(e) {
    e.preventDefault();
    try {
      await api.post('/users', { ...newPerson, name: newPerson.name.trim() || null });
      ok(`${newPerson.email} added. Tell them their first password.`);
      setNewPerson({ email: '', name: '', password: '', role: 'user' });
      setAdding(false);
      await loadAll();
    } catch (err) { fail(err); }
  }

  async function patchUser(id, patch) {
    try {
      await api.patch(`/users/${id}`, patch);
      await loadAll();
    } catch (err) { fail(err); }
  }

  async function loadKeys() {
    const k = await api.get('/company/llm-keys');
    setKeys(k.keys);
    setKeysMeta({ models: k.models || [], fallbackKey: !!k.fallbackKey });
  }

  // The answer is shown beside the key and written onto it by the server, so
  // the status line and the button agree after a reload.
  async function testKey(id) {
    setKeyTests(t => ({ ...t, [id]: { busy: true } }));
    try {
      const r = await api.post(`/company/llm-keys/${id}/test`, {});
      setKeyTests(t => ({ ...t, [id]: { color: 'var(--success)', text: `Works · ${r.model} · ${r.latencyMs} ms` } }));
    } catch (err) {
      setKeyTests(t => ({ ...t, [id]: { color: 'var(--danger)', text: err.message } }));
    }
    loadKeys().catch(() => {});
  }

  async function saveXero(e) {
    e.preventDefault();
    try {
      await api.patch('/xero/credentials', xeroForm);
      await loadAll();
      ok('Xero settings saved.');
    } catch (err) { fail(err); }
  }

  async function testXero() {
    try {
      const r = await api.post('/xero/test', {});
      await loadAll();
      ok(`Connected: ${r.tenants.map(t => t.tenantName).join(', ')}`);
    } catch (err) { fail(err); }
  }

  async function connectXero() {
    try {
      const d = await api.get('/xero/oauth/connect');
      window.location.href = d.url;
    } catch (err) { fail(err); }
  }

  async function addKey(e) {
    e.preventDefault();
    try {
      await api.post('/company/llm-keys', newKey);
      setNewKey({ apiKey: '', label: '' });
      await loadKeys();
      ok('LLM API key added.');
    } catch (err) { fail(err); }
  }

  if (!company) return <div style={{ color: 'var(--text-muted)', padding: 24 }}>{msg?.text || 'Loading settings…'}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 920 }}>
      <div className="page-header">
        <h1>Settings</h1>
        <p>{isAdmin ? 'System configuration, users & monitoring, and administrative controls.' : 'Manage your personal account profile, security, and display preferences.'}</p>
      </div>
      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}

      {/* Admin Tab Navigation Bar */}
      {isAdmin && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 4 }}>
          {ADMIN_TABS.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setAdminTab(t.key)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', borderRadius: 8, fontSize: 13,
                fontWeight: adminTab === t.key ? 600 : 500,
                background: adminTab === t.key ? 'var(--accent)' : 'var(--bg-secondary)',
                color: adminTab === t.key ? 'var(--accent-text, #fff)' : 'var(--text-secondary)',
                border: '1px solid ' + (adminTab === t.key ? 'var(--accent)' : 'var(--border)'),
                cursor: 'pointer', transition: 'all 0.15s ease'
              }}>
              <span>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Personal Settings (For regular user OR admin profile tab) */}
      {(!isAdmin || adminTab === 'profile') && (
        <PersonalSettings
          user={user}
          company={company}
          theme={theme}
          toggleTheme={toggleTheme}
          onOpenPassword={() => setPwFor(user)}
          nameInput={nameInput}
          setNameInput={setNameInput}
          onSaveProfile={saveProfile}
          onNotify={setMsg}
        />
      )}

      {/* Admin Tab 1: Users & Usage Monitoring */}
      {isAdmin && adminTab === 'monitoring' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="card-title">Users & Usage Monitoring</div>
              <div className="card-subtitle">Real-time overview of user activity, receipts uploaded, and expense claims.</div>
            </div>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => setAdding(a => !a)}>{adding ? 'Close' : '+ Add a person'}</button>
          </div>

          {/* Adding someone is an admin's job: self-registration is off unless
              switched on in Company & Policy. */}
          {adding && (
            <form onSubmit={addPerson} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8, marginTop: 12, padding: 12, borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              <input className="form-input" type="email" required placeholder="Email" value={newPerson.email} onChange={e => setNewPerson({ ...newPerson, email: e.target.value })} aria-label="Email" autoComplete="off" />
              <input className="form-input" placeholder="Name" value={newPerson.name} onChange={e => setNewPerson({ ...newPerson, name: e.target.value })} aria-label="Name" />
              <input className="form-input" type="password" required minLength={8} placeholder="First password, 8+ characters" value={newPerson.password} onChange={e => setNewPerson({ ...newPerson, password: e.target.value })} aria-label="First password" autoComplete="new-password" />
              <select className="form-input" value={newPerson.role} onChange={e => setNewPerson({ ...newPerson, role: e.target.value })} aria-label="Role">
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <button className="btn btn-primary" type="submit">Add</button>
              <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: 'var(--text-muted)' }}>Tell them the first password yourself; it is not emailed. They can change it in My Profile.</div>
            </form>
          )}

          {/* Aggregated Usage Overview Metrics */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: 12,
            marginTop: 14,
            marginBottom: 16,
          }}>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total Accounts</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>{users.length}</div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Online Now</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--success, #10b981)', marginTop: 2 }}>
                {users.filter(u => u.online).length}
              </div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Receipts Recorded</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>
                {users.reduce((acc, u) => acc + (u.receiptCount || 0), 0)}
              </div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Cases Claimed</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>
                {users.reduce((acc, u) => acc + (u.claimedCaseCount || 0), 0)}
                <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}> / {users.reduce((acc, u) => acc + (u.caseCount || 0), 0)}</span>
              </div>
            </div>
            <div style={{ background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total Claimed</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent, #6366f1)', marginTop: 2 }}>
                {company.baseCurrency} {(users.reduce((acc, u) => acc + (u.claimedCents || 0), 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th style={{ textAlign: 'center' }}>Receipts</th>
                  <th style={{ textAlign: 'center' }}>Cases (Claimed / Total)</th>
                  <th style={{ textAlign: 'right' }}>Total Claimed</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} style={u.removed ? { opacity: 0.6 } : undefined}>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{u.email}</div>
                      {u.name && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.name}</div>}
                    </td>
                    <td>
                      <select
                        className="form-input"
                        style={{ padding: '3px 8px', fontSize: 12, width: 'auto' }}
                        value={u.role}
                        onChange={e => patchUser(u.id, { role: e.target.value })}
                        disabled={u.id === user.id || u.removed}
                      >
                        {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                      {u.receiptCount || 0}
                    </td>
                    <td style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                      <span style={{ fontWeight: 600, color: (u.claimedCaseCount || 0) > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {u.claimedCaseCount || 0}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}> / {u.caseCount || 0}</span>
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>
                      {company.baseCurrency} {((u.claimedCents || 0) / 100).toFixed(2)}
                    </td>
                    <td>
                      {u.removed ? (
                        <span className="badge badge-gray" style={{ fontSize: 11 }}>Removed</span>
                      ) : u.online ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--success, #10b981)', fontWeight: 600 }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success, #10b981)' }} />
                          Online
                        </span>
                      ) : (
                        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          {u.lastSeenAt ? `Seen ${new Date(u.lastSeenAt).toLocaleDateString()}` : 'Offline'}
                        </span>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {u.removed ? (
                        <button className="btn btn-ghost btn-sm" onClick={() => api.post(`/users/${u.id}/restore`, {}).then(() => { ok(`${u.name || u.email} can sign in again.`); return loadAll(); }).catch(fail)} title="Let them sign in again">
                          Restore
                        </button>
                      ) : (
                        <>
                          <button className="btn btn-ghost btn-sm" onClick={() => setPwFor(u)} title="Set or reset password">
                            Password
                          </button>
                          {u.id !== user.id && (
                            <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(u)} style={{ color: 'var(--danger, #ef4444)' }} title="End their access; their claims stay">
                              Remove
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Admin Tab 2: Company & Policy */}
      {isAdmin && adminTab === 'company' && (
        <form className="card" onSubmit={saveCompany}>
          <div className="card-title">Company & Policy Settings</div>
          <div className="card-subtitle">The base currency every report totals in, and how foreign amounts are converted.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 12px' }}>
            <div className="form-group"><label className="form-label" htmlFor="c-name">Name</label><input id="c-name" className="form-input" value={company.name} onChange={e => setCompany({ ...company, name: e.target.value })} /></div>
            <div className="form-group"><label className="form-label" htmlFor="c-ccy">Base currency</label><input id="c-ccy" className="form-input" value={company.baseCurrency} maxLength={3} onChange={e => setCompany({ ...company, baseCurrency: e.target.value })} /></div>
            <div className="form-group"><label className="form-label" htmlFor="c-tz">Timezone</label><input id="c-tz" className="form-input" value={company.timezone} onChange={e => setCompany({ ...company, timezone: e.target.value })} /></div>
            <div className="form-group"><label className="form-label" htmlFor="c-fx">Exchange-rate policy</label>
              <select id="c-fx" className="form-input" value={company.fxPolicy} onChange={e => setCompany({ ...company, fxPolicy: e.target.value })}>{POLICIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          </div>
          <div className="form-group"><label className="form-label" htmlFor="c-cols">Report columns (in order, comma separated)</label><input id="c-cols" className="form-input" value={columns} onChange={e => setColumns(e.target.value)} /></div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, margin: '4px 0 14px', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!company.allowRegistration} onChange={e => setCompany({ ...company, allowRegistration: e.target.checked })} style={{ marginTop: 3 }} />
            <span>
              Let people create their own account
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                Off: only an admin can add people, in Users &amp; Monitoring. On: anyone who reaches the sign-in page can join this company as a user.
              </span>
            </span>
          </label>
          <button className="btn btn-primary" type="submit">Save company settings</button>
        </form>
      )}

      {/* Admin Tab 3: Xero Integration */}
      {isAdmin && adminTab === 'xero' && xero && (
        <form className="card" onSubmit={saveXero}>
          <div className="card-title">Xero Integration</div>
          <div className="card-subtitle">Once connected, each person can send their own claimed case to Xero as a draft bill payable to them. Connect with a Custom Connection (client id and secret) or with the OAuth web-app flow. Solv asks Xero only for bills, contacts, account settings and attachments.</div>
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

      {/* Admin Tab 4: LLM API Setup */}
      {isAdmin && adminTab === 'keys' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="card-title">LLM API Keys</div>
              <div className="card-subtitle">
                The AI that reads receipts uses these keys. Personal keys in My Profile are tried first; when a key runs out
                of quota the next one is used.
              </div>
            </div>
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noreferrer"
              className="btn btn-outline btn-sm"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
            >
              <span>Google AI Studio ↗</span>
            </a>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '10px 0 4px', lineHeight: 1.5 }}>
            {keysMeta.models.length > 0 && <>Receipts are read by <code>{keysMeta.models[0]}</code>{keysMeta.models.length > 1 && <>, falling back to <code>{keysMeta.models.slice(1).join(', ')}</code></>}. </>}
            {keysMeta.fallbackKey
              ? 'When none of these keys works, the server’s own key is used.'
              : 'The server has no key of its own, so at least one key here or in someone’s profile must work.'}
          </div>
          {keys.map(k => {
            const s = keyStatus(k);
            const t = keyTests[k.id];
            return (
              <div key={k.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
                <div style={{ minWidth: 0 }}>
                  <div><code>{k.keyMasked}</code> {k.label && <span style={{ color: 'var(--text-muted)' }}>· {k.label}</span>}</div>
                  <div style={{ fontSize: 11.5, color: s.color, marginTop: 2 }}>{s.text}</div>
                  {t && !t.busy && <div style={{ fontSize: 11.5, color: t.color, marginTop: 2 }}>{t.text}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-outline btn-sm" disabled={!!(t && t.busy)} onClick={() => testKey(k.id)}>{t && t.busy ? 'Testing…' : 'Test'}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => api.delete(`/company/llm-keys/${k.id}`).then(loadKeys).catch(fail)}>Remove</button>
                </div>
              </div>
            );
          })}
          {!keys.length && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '8px 0', borderTop: '1px solid var(--border)' }}>No company key yet.</div>}
          <form onSubmit={addKey} style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <input className="form-input" style={{ flex: 2, minWidth: 220 }} placeholder="Paste a Gemini API key" required autoComplete="off"
                   value={newKey.apiKey} onChange={e => setNewKey({ ...newKey, apiKey: e.target.value })} aria-label="API key" />
            <input className="form-input" style={{ flex: 1, minWidth: 120 }} placeholder="Label" value={newKey.label} onChange={e => setNewKey({ ...newKey, label: e.target.value })} aria-label="Label" />
            <button className="btn btn-primary" type="submit">Add company key</button>
          </form>
        </div>
      )}

      {/* Admin Tab 5: Exchange Rates — the live board and its daily log */}
      {isAdmin && adminTab === 'fx' && (
        <ExchangeRates isAdmin={isAdmin} currencies={currencies} onNotify={setMsg} />
      )}

      {confirm && (
        <ConfirmDialog
          title={`Remove ${confirm.name || confirm.email}?`}
          message="They can no longer sign in, and any session they have ends now. Their receipts, cases and totals stay, and you can restore them later."
          confirmLabel="Remove"
          danger
          onConfirm={() => api.delete(`/users/${confirm.id}`).then(loadAll).catch(fail).finally(() => setConfirm(null))}
          onCancel={() => setConfirm(null)}
        />
      )}

      {pwFor && (
        <PasswordDialog
          target={pwFor}
          self={pwFor.id === user.id}
          onDone={m => { setPwFor(null); setMsg(m); }}
          onCancel={() => setPwFor(null)}
        />
      )}
    </div>
  );
}

// ── Personal Settings Sub-Component ──────────────────────────────────────────
function PersonalSettings({ user, company, theme, toggleTheme, onOpenPassword, nameInput, setNameInput, onSaveProfile, onNotify }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 1. Account & Profile Card */}
      <div className="card">
        <div className="card-title">My Account Profile</div>
        <div className="card-subtitle">Your identity and role in this company.</div>
        <form onSubmit={onSaveProfile} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 12px' }}>
          <div className="form-group">
            <label className="form-label" htmlFor="u-email">Email</label>
            <input id="u-email" className="form-input" value={user?.email || ''} disabled style={{ opacity: 0.8 }} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="u-name">Display Name</label>
            <input id="u-name" className="form-input" placeholder="e.g. John Tan" value={nameInput} onChange={e => setNameInput(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Role</label>
            <div style={{ paddingTop: 8 }}>
              <span className={`badge ${user?.role === 'admin' ? 'badge-yellow' : 'badge-blue'}`} style={{ textTransform: 'capitalize', fontSize: 12, padding: '4px 10px' }}>
                {user?.role === 'admin' ? '👑 Administrator' : '👤 User (Claimant)'}
              </span>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Company</label>
            <div style={{ paddingTop: 8, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              {user?.companyName || company?.name || 'Solv'}
            </div>
          </div>
          <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
            <button className="btn btn-primary" type="submit">Save Profile Name</button>
          </div>
        </form>
      </div>

      {/* 2. Personal Google Gemini API Keys */}
      <UserGeminiSection onNotify={onNotify} />

      {/* 3. My Claims & Activity Stats Card */}
      <div className="card">
        <div className="card-title">My Claims & Activity</div>
        <div className="card-subtitle">Overview of your submitted receipts and claim cases.</div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: 12,
          marginTop: 10,
        }}>
          <div style={{ background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Receipts Recorded</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>{user?.receiptCount || 0}</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total Cases</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>{user?.caseCount || 0}</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Cases Claimed</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--success, #10b981)', marginTop: 2 }}>{user?.claimedCaseCount || 0}</div>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total Claimed</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent, #6366f1)', marginTop: 2 }}>
              {company?.baseCurrency || 'SGD'} {((user?.claimedCents || 0) / 100).toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* 3. Appearance & Preferences Card */}
      <div className="card">
        <div className="card-title">Preferences & Display</div>
        <div className="card-subtitle">Adjust your theme and review regional system formats.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>Interface Theme</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>Toggle between light and dark visual themes.</div>
            <button className="btn btn-outline" type="button" onClick={toggleTheme} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span>{theme === 'dark' ? '🌙' : '☀️'}</span>
              <span>{theme === 'dark' ? 'Dark Mode (Switch to Light)' : 'Light Mode (Switch to Dark)'}</span>
            </button>
          </div>
          <div style={{ background: 'var(--bg-secondary)', padding: '12px 16px', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Claim Base Currency</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginTop: 2 }}>{company?.baseCurrency || 'SGD'}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>Timezone</div>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', marginTop: 2 }}>{company?.timezone || 'Asia/Singapore'}</div>
          </div>
        </div>
      </div>

      {/* 4. Security Card */}
      <div className="card">
        <div className="card-title">Security & Password</div>
        <div className="card-subtitle">Keep your account protected with a personal password.</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Password</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>You will be prompted for your current password to set a new one (at least 6 characters).</div>
          </div>
          <button className="btn btn-primary" type="button" onClick={onOpenPassword}>Change Password</button>
        </div>
      </div>
    </div>
  );
}

// ── Password Dialog Modal ───────────────────────────────────────────────────
function PasswordDialog({ target, self, onDone, onCancel }) {
  const [currentPassword, setCurrent] = useState('');
  const [password, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/users/${target.id}/password`, self ? { password, currentPassword } : { password });
      // A new password ends every session, this one included; the server
      // hands back a fresh one so this device stays signed in.
      if (self && r.token) localStorage.setItem('token', r.token);
      onDone({ tone: 'success', text: self ? 'Your password has been changed, and every other device has been signed out.' : `Password set for ${target.name || target.email}. Any session they had has ended.` });
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }

  return (
    <Modal onClose={onCancel} busy={busy} maxWidth={400} label={self ? 'Change your password' : 'Set a password'}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{self ? 'Change your password' : `Set a password for ${target.name || target.email}`}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14 }}>
        {self ? 'You will stay signed in on this device.' : 'Tell them the new password yourself; it is not emailed.'}
      </div>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {err && <div className="alert alert-error" style={{ marginBottom: 0 }}>{err}</div>}
        {self && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="pw-current">Current password</label>
            <input id="pw-current" className="form-input" type="password" required value={currentPassword} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" />
          </div>
        )}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="pw-new">New password</label>
          <input id="pw-new" className="form-input" type="password" required minLength={8} value={password} onChange={e => setNext(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ── Personal Gemini Keys Component ──────────────────────────────────────────
function UserGeminiSection({ onNotify }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState({ apiKey: '', label: '' });
  const [showKey, setShowKey] = useState(false);
  const [testingNew, setTestingNew] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testingKeyId, setTestingKeyId] = useState(null);
  const [existingKeyResults, setExistingKeyResults] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadKeys();
  }, []);

  async function loadKeys() {
    try {
      setLoading(true);
      const res = await api.get('/users/me/gemini-keys');
      setKeys(res.keys || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function testRawKey() {
    if (!newKey.apiKey.trim()) {
      setTestResult({ tone: 'error', text: 'Please enter a Gemini API key first.' });
      return;
    }
    setTestingNew(true);
    setTestResult(null);
    try {
      const res = await api.post('/users/me/gemini-keys/test', { apiKey: newKey.apiKey.trim() });
      setTestResult({ tone: 'success', text: `✓ Verified! Model: ${res.model} (${res.latencyMs}ms)` });
    } catch (err) {
      setTestResult({ tone: 'error', text: `✗ Verification failed: ${err.message}` });
    } finally {
      setTestingNew(false);
    }
  }

  async function testExistingKey(keyId) {
    setTestingKeyId(keyId);
    try {
      const res = await api.post('/users/me/gemini-keys/test', { keyId });
      setExistingKeyResults(prev => ({
        ...prev,
        [keyId]: { tone: 'success', text: `✓ Operational (${res.model}, ${res.latencyMs}ms)` }
      }));
    } catch (err) {
      setExistingKeyResults(prev => ({
        ...prev,
        [keyId]: { tone: 'error', text: `✗ Failed: ${err.message}` }
      }));
    } finally {
      setTestingKeyId(null);
    }
  }

  async function saveKey(e) {
    e.preventDefault();
    if (!newKey.apiKey.trim()) return;
    setSaving(true);
    try {
      await api.post('/users/me/gemini-keys', {
        apiKey: newKey.apiKey.trim(),
        label: newKey.label.trim()
      });
      setNewKey({ apiKey: '', label: '' });
      setTestResult(null);
      await loadKeys();
      if (onNotify) onNotify({ tone: 'success', text: 'Gemini API key saved securely.' });
    } catch (err) {
      if (onNotify) onNotify({ tone: 'error', text: err.message });
      else setTestResult({ tone: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function removeKey(id) {
    try {
      await api.delete(`/users/me/gemini-keys/${id}`);
      await loadKeys();
      if (onNotify) onNotify({ tone: 'success', text: 'Gemini API key removed.' });
    } catch (err) {
      if (onNotify) onNotify({ tone: 'error', text: err.message });
    }
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>🔑</span>
            <span>My LLM API Key (Google Gemini)</span>
          </div>
          <div className="card-subtitle">
            Configure your personal Google Gemini API key to parse uploaded receipts and invoices.
          </div>
        </div>
        <a
          href="https://aistudio.google.com/app/apikey"
          target="_blank"
          rel="noreferrer"
          className="btn btn-outline btn-sm"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
        >
          <span>Get Free Key at Google AI Studio</span>
          <span>↗</span>
        </a>
      </div>

      {/* Info Callout */}
      <div style={{
        marginTop: 12,
        marginBottom: 16,
        padding: '10px 14px',
        borderRadius: 8,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        fontSize: 12.5,
        lineHeight: 1.5,
        color: 'var(--text-secondary)'
      }}>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
          💡 How Receipt Processing Works:
        </div>
        When you upload or import receipts, our AI extraction pipeline parses dates, merchants, totals, line items, and taxes using your personal Gemini key. If no personal key is added, it safely falls back to the company pool. Stored keys are encrypted at rest with AES-256-GCM.
      </div>

      {/* Active Keys List */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
          Your Saved Gemini Keys {keys.length > 0 && `(${keys.length})`}
        </div>

        {loading ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '8px 0' }}>Loading keys…</div>
        ) : keys.length === 0 ? (
          <div style={{
            fontSize: 12.5,
            color: 'var(--text-muted)',
            padding: '12px 14px',
            background: 'var(--bg-secondary)',
            borderRadius: 8,
            border: '1px dashed var(--border)'
          }}>
            No personal key configured yet. Add your Google Gemini API key below to use your own quota.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {keys.map(k => (
              <div
                key={k.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 10,
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <code style={{ fontSize: 13, fontWeight: 600 }}>{k.keyMasked}</code>
                  {k.label ? (
                    <span className="badge badge-blue" style={{ fontSize: 11 }}>{k.label}</span>
                  ) : (
                    <span className="badge badge-gray" style={{ fontSize: 11 }}>Personal Key</span>
                  )}
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    Added {new Date(k.createdAt).toLocaleDateString()}
                  </span>
                  {!existingKeyResults[k.id] && (
                    <span style={{ fontSize: 11.5, color: keyStatus(k).color }}>{keyStatus(k).text}</span>
                  )}
                  {existingKeyResults[k.id] && (
                    <span style={{
                      fontSize: 11.5,
                      fontWeight: 500,
                      color: existingKeyResults[k.id].tone === 'success' ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)'
                    }}>
                      {existingKeyResults[k.id].text}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={testingKeyId === k.id}
                    onClick={() => testExistingKey(k.id)}
                    title="Ping Google AI Studio to verify key validity"
                  >
                    {testingKeyId === k.id ? 'Testing…' : '⚡ Test Key'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ color: 'var(--danger, #ef4444)' }}
                    onClick={() => removeKey(k.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add New Key Form */}
      <form onSubmit={saveKey} style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
          Add New Gemini API Key
        </div>

        {testResult && (
          <div
            className={`alert alert-${testResult.tone}`}
            style={{ marginBottom: 12, fontSize: 12.5, padding: '8px 12px' }}
          >
            {testResult.text}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 12px' }}>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label" htmlFor="user-gemini-key">
              API Key (Google AI Studio)
            </label>
            <div style={{ position: 'relative' }}>
              <input
                id="user-gemini-key"
                className="form-input"
                type={showKey ? 'text' : 'password'}
                placeholder="Paste a Gemini API key"
                required
                value={newKey.apiKey}
                onChange={e => {
                  setNewKey({ ...newKey, apiKey: e.target.value });
                  setTestResult(null);
                }}
                style={{ paddingRight: 40, fontFamily: showKey ? 'var(--font-mono)' : 'inherit' }}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                  fontSize: 13,
                  padding: 4
                }}
                title={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? '🙈' : '👁️'}
              </button>
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label" htmlFor="user-gemini-label">
              Label (Optional)
            </label>
            <input
              id="user-gemini-label"
              className="form-input"
              placeholder="e.g. My AI Studio, Work Key"
              value={newKey.label}
              onChange={e => setNewKey({ ...newKey, label: e.target.value })}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={saving || !newKey.apiKey.trim()}
          >
            {saving ? 'Saving Key…' : 'Save Gemini Key'}
          </button>
          <button
            className="btn btn-outline"
            type="button"
            onClick={testRawKey}
            disabled={testingNew || !newKey.apiKey.trim()}
            title="Send a lightweight ping to Google AI Studio to check if this key works"
          >
            {testingNew ? 'Testing Key…' : '⚡ Test Connection'}
          </button>
        </div>
      </form>
    </div>
  );
}
