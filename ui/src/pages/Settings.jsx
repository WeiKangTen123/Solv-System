import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { fmtRate } from '../utils/format';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';

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
  { key: 'keys',       label: 'Receipt Reader Keys', icon: '🔑' },
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
  const [rates, setRates] = useState([]);
  const [xero, setXero] = useState(null);
  const [xeroForm, setXeroForm] = useState({ XERO_CLIENT_ID: '', XERO_CLIENT_SECRET: '', XERO_OAUTH_CLIENT_ID: '', XERO_OAUTH_CLIENT_SECRET: '', DEFAULT_ACCOUNT_CODE: '' });
  const [params, setParams] = useSearchParams();
  const [newRate, setNewRate] = useState({ from: '', date: new Date().toISOString().slice(0, 10), rate: '' });
  const [newKey, setNewKey] = useState({ apiKey: '', label: '' });
  const [currencies, setCurrencies] = useState([]);
  const [msg, setMsg] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [pwFor, setPwFor] = useState(null);
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
      setKeys((await api.get('/company/llm-keys')).keys);
      setRates((await api.get('/fx/rates')).rates.slice(0, 30));
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
        reportColumns: columns.split(',').map(s => s.trim()).filter(Boolean)
      });
      await loadAll();
      await refreshUser();
      ok('Company settings saved.');
    } catch (err) { fail(err); }
  }

  async function patchUser(id, patch) {
    try {
      await api.patch(`/users/${id}`, patch);
      await loadAll();
    } catch (err) { fail(err); }
  }

  async function addRate(e) {
    e.preventDefault();
    try {
      await api.post('/fx/rates', { from: newRate.from.toUpperCase(), date: newRate.date, rate: Number(newRate.rate) });
      setNewRate({ ...newRate, from: '', rate: '' });
      await loadAll();
      ok('Rate saved.');
    } catch (err) { fail(err); }
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
      await loadAll();
      ok('Reader key added.');
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
          </div>

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
                  <tr key={u.id}>
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
                        disabled={u.id === user.id}
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
                      {u.online ? (
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
                      <button className="btn btn-ghost btn-sm" onClick={() => setPwFor(u)} title="Set or reset password">
                        Password
                      </button>
                      {u.id !== user.id && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(u)} style={{ color: 'var(--danger, #ef4444)' }} title="Remove user account">
                          Remove
                        </button>
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
          <button className="btn btn-primary" type="submit">Save company settings</button>
        </form>
      )}

      {/* Admin Tab 3: Xero Integration */}
      {isAdmin && adminTab === 'xero' && xero && (
        <form className="card" onSubmit={saveXero}>
          <div className="card-title">Xero Integration</div>
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

      {/* Admin Tab 4: Receipt Reader Keys */}
      {isAdmin && adminTab === 'keys' && (
        <div className="card">
          <div className="card-title">Receipt Reader Keys</div>
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
      )}

      {/* Admin Tab 5: Exchange Rates */}
      {isAdmin && adminTab === 'fx' && (
        <div className="card">
          <div className="card-title">Exchange Rates</div>
          <div className="card-subtitle">Rates used so far, newest first. A rate entered here beats the provider's for that day; use it for a monthly fixed table or a correction.</div>
          <datalist id="currency-options">
            {currencies.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </datalist>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
            Any currency a receipt is printed in works: {currencies.slice(0, 8).map(c => c.code).join(', ')} and {Math.max(0, currencies.length - 8)} more are offered by name,
            and any other three-letter code can be typed.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Date</th><th>Pair</th><th style={{ textAlign: 'right' }}>Rate</th><th>Source</th><th></th></tr></thead>
              <tbody>{rates.map(r => (
                <tr key={`${r.from}-${r.to}-${r.rateDate}-${r.source}`}>
                  <td>{r.rateDate}{r.providerDate && r.providerDate !== r.rateDate ? <span style={{ color: 'var(--text-muted)' }}> (priced {r.providerDate})</span> : null}</td>
                  <td>{r.from} → {r.to}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }} title={String(r.rate)}>{fmtRate(r.rate)}</td>
                  <td>{r.source}{r.enteredBy ? <span style={{ color: 'var(--text-muted)' }}> · {r.enteredBy}</span> : null}</td>
                  <td>{r.source === 'manual' && <button className="btn btn-ghost btn-sm" onClick={() => api.delete(`/fx/rates?from=${r.from}&to=${r.to}&date=${r.rateDate}`).then(loadAll).catch(fail)}>Remove</button>}</td>
                </tr>))}</tbody>
            </table>
            {!rates.length && <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>No rates fetched yet.</div>}
          </div>
          <form onSubmit={addRate} style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <input id="rate-from" className="form-input" style={{ maxWidth: 110 }} placeholder="IDR" maxLength={3} required list="currency-options"
                   value={newRate.from} onChange={e => setNewRate({ ...newRate, from: e.target.value.toUpperCase().slice(0, 3) })} aria-label="From currency" />
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>→ {company.baseCurrency} on</span>
            <input id="rate-date" className="form-input" type="date" style={{ maxWidth: 170 }} required value={newRate.date} onChange={e => setNewRate({ ...newRate, date: e.target.value })} aria-label="Date" />
            <input id="rate-value" className="form-input" type="number" step="any" min="0" style={{ maxWidth: 150 }} placeholder="0.01341" required value={newRate.rate} onChange={e => setNewRate({ ...newRate, rate: e.target.value })} aria-label="Rate" />
            <button className="btn btn-primary" type="submit">Save rate</button>
          </form>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={`Remove ${confirm.name || confirm.email}?`}
          message="Their expenses stay; they can no longer sign in."
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
function PersonalSettings({ user, company, theme, toggleTheme, onOpenPassword, nameInput, setNameInput, onSaveProfile }) {
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

      {/* 2. My Claims & Activity Stats Card */}
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
      await api.post(`/users/${target.id}/password`, self ? { password, currentPassword } : { password });
      onDone({ tone: 'success', text: self ? 'Your password has been changed.' : `Password set for ${target.name || target.email}.` });
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
          <input id="pw-new" className="form-input" type="password" required minLength={6} value={password} onChange={e => setNext(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
        </div>
      </form>
    </Modal>
  );
}
