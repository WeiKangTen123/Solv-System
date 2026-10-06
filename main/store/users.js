const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');

const DEFAULT_TIMEZONE = 'Asia/Singapore';
const DEFAULT_COMPANY  = { name: 'Solv', baseCurrency: 'SGD', fxPolicy: 'receipt_date', timezone: DEFAULT_TIMEZONE };
// The report's column set, in column order. Matches intake/categories.js names
// so a category on a line is also a column on paper.
const DEFAULT_REPORT_COLUMNS = ['Air & Transport', 'Lodging', 'Meals', 'Entertainment', 'Phone', 'Fuel/Mileage', 'Other'];
// Two. An admin runs the company's settings and staff and can see every case;
// a user works their own. Nobody is anybody's manager, because nothing here is
// routed through one.
const ROLES = ['user', 'admin'];
const ONLINE_THRESHOLD_MS = 3 * 60 * 1000;

function isOnline(lastSeenAt) { return !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS; }

// The shortest password anyone may set from now on. Existing passwords keep
// working until they are changed.
const MIN_PASSWORD = 8;

function sanitize(u) {
  if (!u) return null;
  return {
    id: u.id, companyId: u.company_id, email: u.email, role: u.role, name: u.name || null,
    employeeId: u.employee_id || null, department: u.department || null,
    createdAt: u.created_at, lastSeenAt: u.last_seen_at || null, online: isOnline(u.last_seen_at),
    removedAt: u.disabled_at || null, removed: !!u.disabled_at,
  };
}

// ── Companies ────────────────────────────────────────────────────────────────
function _companyRow(row) {
  if (!row) return null;
  let cols = [];
  try { cols = JSON.parse(row.report_columns || '[]'); } catch { cols = []; }
  return {
    id: row.id, name: row.name, baseCurrency: row.base_currency, fxPolicy: row.fx_policy, timezone: row.timezone,
    reportColumns: cols, logo: row.logo || null, nextReportNo: row.next_report_no, createdAt: row.created_at,
    allowRegistration: !!row.allow_registration,
  };
}

function getCompany(id) { return _companyRow(db.prepare('SELECT * FROM companies WHERE id = ?').get(id)); }

function createCompany(patch = {}) {
  const id = `c${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  db.prepare(`INSERT INTO companies (id, name, base_currency, fx_policy, timezone, report_columns, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, patch.name || DEFAULT_COMPANY.name, patch.baseCurrency || DEFAULT_COMPANY.baseCurrency,
         patch.fxPolicy || DEFAULT_COMPANY.fxPolicy, patch.timezone || DEFAULT_COMPANY.timezone,
         JSON.stringify(patch.reportColumns || DEFAULT_REPORT_COLUMNS), new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO company_credentials (company_id) VALUES (?)').run(id);
  return getCompany(id);
}

const COMPANY_COLUMNS = { name: 'name', baseCurrency: 'base_currency', fxPolicy: 'fx_policy', timezone: 'timezone', logo: 'logo' };
function updateCompany(id, patch) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries(COMPANY_COLUMNS)) {
    if (patch[k] === undefined) continue;
    sets.push(`${col} = ?`); args.push(patch[k]);
  }
  if (patch.allowRegistration !== undefined) { sets.push('allow_registration = ?'); args.push(patch.allowRegistration ? 1 : 0); }
  if (Array.isArray(patch.reportColumns)) {
    sets.push('report_columns = ?');
    args.push(JSON.stringify(patch.reportColumns.map(c => String(c).trim()).filter(Boolean)));
  }
  if (sets.length) db.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return getCompany(id);
}

// Company credentials (Xero). Secrets encrypted; a blank patch value clears.
const CRED_COLUMNS = {
  XERO_CLIENT_ID: 'xero_client_id', XERO_CLIENT_SECRET: 'xero_client_secret',
  XERO_OAUTH_CLIENT_ID: 'xero_oauth_client_id', XERO_OAUTH_CLIENT_SECRET: 'xero_oauth_client_secret',
  XERO_OAUTH_REFRESH_TOKEN: 'xero_oauth_refresh_token', XERO_OAUTH_CONNECTED_AT: 'xero_oauth_connected_at',
  XERO_CONNECTION_TYPE: 'xero_connection_type', DEFAULT_ACCOUNT_CODE: 'default_account_code',
  FX_OXR_APP_ID: 'fx_oxr_app_id',
};
const CRED_TO_KEY = Object.fromEntries(Object.entries(CRED_COLUMNS).map(([k, v]) => [v, k]));
const ENCRYPTED_COLUMNS = new Set(['xero_client_secret', 'xero_oauth_client_secret', 'xero_oauth_refresh_token', 'fx_oxr_app_id']);

function getCompanyConfig(companyId) {
  const row = db.prepare('SELECT * FROM company_credentials WHERE company_id = ?').get(companyId);
  if (!row) return {};
  const out = {};
  for (const [col, value] of Object.entries(row)) {
    if (col === 'company_id' || value === null) continue;
    out[CRED_TO_KEY[col]] = ENCRYPTED_COLUMNS.has(col) ? decrypt(value) : value;
  }
  return out;
}

function saveCompanyConfig(companyId, patch) {
  db.prepare('INSERT OR IGNORE INTO company_credentials (company_id) VALUES (?)').run(companyId);
  const sets = [], args = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = CRED_COLUMNS[key];
    if (!col || value === undefined || value === null) continue;
    sets.push(`${col} = ?`);
    args.push(value === '' ? null : (ENCRYPTED_COLUMNS.has(col) ? encrypt(value) : value));
  }
  if (sets.length) db.prepare(`UPDATE company_credentials SET ${sets.join(', ')} WHERE company_id = ?`).run(...args, companyId);
  return getCompanyConfig(companyId);
}

// ── Users ────────────────────────────────────────────────────────────────────
function hasUsers() { return db.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined; }
function findById(id) { return sanitize(db.prepare('SELECT * FROM users WHERE id = ?').get(id)); }
function _rawByEmail(email) { return db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email) || null; }
function findByEmail(email) { return sanitize(_rawByEmail(email)); }

const _lastTouchWrite = new Map();
const TOUCH_THROTTLE_MS = 60 * 1000;
function touchLastSeen(userId) {
  const now = Date.now();
  if (now - (_lastTouchWrite.get(userId) || 0) < TOUCH_THROTTLE_MS) return;
  _lastTouchWrite.set(userId, now);
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(new Date(now).toISOString(), userId);
}

// The first account ever creates the company and is its admin. Every later
// account must name a company (the admin's, in practice) and is a user unless
// a role is given.
async function createUser({ email, password, name = null, role = null, companyId = null, employeeId = null, department = null }) {
  if (!email || !password) throw new Error('Email and password are required');
  if (String(password).length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  if (role && !ROLES.includes(role)) throw new Error(`Unknown role "${role}"`);
  const hash = await bcrypt.hash(password, 10);
  const create = db.transaction(() => {
    const existing = _rawByEmail(email);
    if (existing && existing.disabled_at) throw new Error('That email belongs to a removed account. Restore it in Users & Monitoring instead.');
    if (existing) throw new Error('Email already exists');
    const first = !hasUsers();
    const company = companyId ? getCompany(companyId) : (first ? createCompany() : null);
    if (!company) throw new Error('A company is required');
    const user = {
      id: `${Date.now()}${crypto.randomBytes(4).toString('hex')}`,
      companyId: company.id, email: email.toLowerCase().trim(), password: hash,
      role: role || (first ? 'admin' : 'user'), name, employeeId, department,
      createdAt: new Date().toISOString(),
    };
    db.prepare(`INSERT INTO users (id, company_id, email, password, name, employee_id, department, role, created_at)
                VALUES (@id, @companyId, @email, @password, @name, @employeeId, @department, @role, @createdAt)`).run(user);
    return findById(user.id);
  });
  return create();
}

// The same work whether or not the account exists. Answering an unknown email
// at once and a known one after a bcrypt comparison told anyone timing the
// login which emails had accounts: 0.1 ms against 75.
const _DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
async function validatePassword(email, password) {
  const raw = _rawByEmail(email);
  const ok = await bcrypt.compare(String(password || ''), raw ? raw.password : _DUMMY_HASH);
  if (!raw || raw.disabled_at || !ok) return null;
  return sanitize(raw);
}

const USER_COLUMNS = { name: 'name', employeeId: 'employee_id', department: 'department', role: 'role' };
function updateUser(id, patch) {
  if (patch.role !== undefined && !ROLES.includes(patch.role)) throw new Error(`Unknown role "${patch.role}"`);
  const sets = [], args = [];
  for (const [k, col] of Object.entries(USER_COLUMNS)) {
    if (patch[k] === undefined) continue;
    sets.push(`${col} = ?`); args.push(patch[k] === '' ? null : patch[k]);
  }
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return findById(id);
}

// A new password ends every session signed in with the old one.
async function setPassword(id, password) {
  if (!password || String(password).length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  db.prepare('UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?').run(await bcrypt.hash(password, 10), id);
}

// ── Sessions ─────────────────────────────────────────────────────────────────
function tokenVersion(id) {
  const r = db.prepare('SELECT token_version FROM users WHERE id = ?').get(id);
  return r ? r.token_version : null;
}
function endSessions(id) { db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id); }

function getAllUsers(companyId) {
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM receipts r WHERE r.user_id = u.id) AS receipt_count,
      (SELECT COUNT(*) FROM expenses e WHERE e.user_id = u.id) AS expense_count,
      (SELECT COUNT(*) FROM expense_reports rep WHERE rep.user_id = u.id) AS case_count,
      (SELECT COUNT(*) FROM expense_reports rep WHERE rep.user_id = u.id AND rep.status = 'claimed') AS claimed_case_count,
      (SELECT COALESCE(SUM(l.base_cents), 0) FROM expenses e JOIN expense_lines l ON l.expense_id = e.id WHERE e.user_id = u.id AND e.claimed_at IS NOT NULL) AS claimed_cents,
      (SELECT COALESCE(SUM(l.base_cents), 0) FROM expenses e JOIN expense_lines l ON l.expense_id = e.id WHERE e.user_id = u.id) AS total_cents,
      (SELECT COUNT(*) FROM assistant_usage a WHERE a.user_id = u.id AND a.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')) AS assistant_30d
    FROM users u
    WHERE u.company_id = ?
    ORDER BY u.disabled_at IS NOT NULL, u.created_at
  `).all(companyId);

  return rows.map(u => ({
    ...sanitize(u),
    receiptCount: u.receipt_count || 0,
    expenseCount: u.expense_count || 0,
    caseCount: u.case_count || 0,
    claimedCaseCount: u.claimed_case_count || 0,
    claimedCents: u.claimed_cents || 0,
    totalCents: u.total_cents || 0,
    assistantQuestions30d: u.assistant_30d || 0,
  }));
}

function getUserMetrics(userId) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM receipts r WHERE r.user_id = ?) AS receipt_count,
      (SELECT COUNT(*) FROM expenses e WHERE e.user_id = ?) AS expense_count,
      (SELECT COUNT(*) FROM expense_reports rep WHERE rep.user_id = ?) AS case_count,
      (SELECT COUNT(*) FROM expense_reports rep WHERE rep.user_id = ? AND rep.status = 'claimed') AS claimed_case_count,
      (SELECT COALESCE(SUM(l.base_cents), 0) FROM expenses e JOIN expense_lines l ON l.expense_id = e.id WHERE e.user_id = ? AND e.claimed_at IS NOT NULL) AS claimed_cents,
      (SELECT COALESCE(SUM(l.base_cents), 0) FROM expenses e JOIN expense_lines l ON l.expense_id = e.id WHERE e.user_id = ?) AS total_cents
  `).get(userId, userId, userId, userId, userId, userId);
  return {
    receiptCount: row ? row.receipt_count : 0,
    expenseCount: row ? row.expense_count : 0,
    caseCount: row ? row.case_count : 0,
    claimedCaseCount: row ? row.claimed_case_count : 0,
    claimedCents: row ? row.claimed_cents : 0,
    totalCents: row ? row.total_cents : 0,
  };
}

// Removing a person ends their access and keeps everything they claimed: the
// row stays, so their receipts, cases and the company's totals do too, and
// the email cannot be taken by somebody else. Restoring undoes it.
function removeUser(id) {
  db.prepare('UPDATE users SET disabled_at = ?, token_version = token_version + 1 WHERE id = ? AND disabled_at IS NULL').run(new Date().toISOString(), id);
  return findById(id);
}
function restoreUser(id) {
  db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(id);
  return findById(id);
}
// Active admins left in the company, so the last one cannot be removed or
// demoted and leave nobody able to run it.
function countAdmins(companyId) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role = 'admin' AND disabled_at IS NULL").get(companyId).n;
}
function readUsers() { return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(sanitize); }
// The company self-registration joins: the first one made.
function firstCompanyId() {
  const r = db.prepare('SELECT company_id FROM users ORDER BY created_at LIMIT 1').get();
  return r ? r.company_id : null;
}

// ── Reader keys (per-user personal keys) ──────────────────────────────────
// What the reader last saw from a key rides along with it, so Settings can
// say which key works and which ran out rather than only listing them.
const _keyRow = r => ({
  id: r.id, apiKey: decrypt(r.api_key), label: r.label, createdAt: r.created_at,
  lastOkAt: r.last_ok_at || null, lastErrorAt: r.last_error_at || null, lastError: r.last_error || null, lastModel: r.last_model || null,
});
const KEY_COLS = 'id, api_key, label, created_at, last_ok_at, last_error_at, last_error, last_model';
function getUserGeminiKeys(userId) {
  try {
    return db.prepare(`SELECT ${KEY_COLS} FROM user_gemini_keys WHERE user_id = ? ORDER BY id`).all(userId).map(_keyRow);
  } catch { return []; }
}
function addUserGeminiKey(userId, apiKey, label) {
  if (!apiKey || !apiKey.trim()) throw new Error('API key is required');
  const info = db.prepare('INSERT INTO user_gemini_keys (user_id, api_key, label, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, encrypt(apiKey.trim()), label ? label.trim().slice(0, 60) : null, new Date().toISOString());
  return { id: info.lastInsertRowid };
}
function removeUserGeminiKey(userId, keyId) {
  return db.prepare('DELETE FROM user_gemini_keys WHERE id = ? AND user_id = ?').run(keyId, userId).changes > 0;
}

// ── Reader keys (company-wide) ──────────────────────────────────────────────
function getGeminiKeys(companyId) {
  return db.prepare(`SELECT ${KEY_COLS} FROM company_gemini_keys WHERE company_id = ? ORDER BY id`).all(companyId).map(_keyRow);
}
// The person's own keys first, then the company's. `scope` says which table
// a key came from, so the reader can report back on the right row.
function getGeminiKeysForUser(userId) {
  const u = findById(userId);
  if (!u) return [];
  return [
    ...getUserGeminiKeys(userId).map(k => ({ ...k, scope: 'user' })),
    ...getGeminiKeys(u.companyId).map(k => ({ ...k, scope: 'company' })),
  ];
}
const KEY_TABLE = { user: 'user_gemini_keys', company: 'company_gemini_keys' };
function recordKeyUse(scope, id, { ok = false, model = null, error = null } = {}) {
  const table = KEY_TABLE[scope];
  if (!table || !id) return;
  const at = new Date().toISOString();
  if (ok) db.prepare(`UPDATE ${table} SET last_ok_at = ?, last_model = COALESCE(?, last_model) WHERE id = ?`).run(at, model, id);
  else db.prepare(`UPDATE ${table} SET last_error_at = ?, last_error = ?, last_model = COALESCE(?, last_model) WHERE id = ?`)
    .run(at, String(error || 'Failed').slice(0, 200), model, id);
}
function addGeminiKey(companyId, apiKey, label) {
  if (!apiKey || !apiKey.trim()) throw new Error('API key is required');
  const info = db.prepare('INSERT INTO company_gemini_keys (company_id, api_key, label, created_at) VALUES (?, ?, ?, ?)')
    .run(companyId, encrypt(apiKey.trim()), label ? label.trim().slice(0, 60) : null, new Date().toISOString());
  return { id: info.lastInsertRowid };
}
function removeGeminiKey(companyId, keyId) {
  return db.prepare('DELETE FROM company_gemini_keys WHERE id = ? AND company_id = ?').run(keyId, companyId).changes > 0;
}

// Per-user defaults the intake modules ask for (currency, timezone).
function getUserDefaults(userId) {
  const u = userId ? findById(userId) : null;
  const c = u ? getCompany(u.companyId) : null;
  return { currency: (c && c.baseCurrency) || 'SGD', timezone: (c && c.timezone) || DEFAULT_TIMEZONE, accountCode: { claim: null } };
}

function ensureUserDirectories() { /* nothing per user to provision yet; kept for index.js symmetry */ }

module.exports = {
  ROLES, DEFAULT_TIMEZONE, DEFAULT_REPORT_COLUMNS, MIN_PASSWORD,
  hasUsers, findById, findByEmail, createUser, validatePassword, updateUser, setPassword, getAllUsers, getUserMetrics,
  removeUser, restoreUser, countAdmins, firstCompanyId, tokenVersion, endSessions, readUsers,
  touchLastSeen, isOnline, sanitize,
  getCompany, createCompany, updateCompany, getCompanyConfig, saveCompanyConfig, ENCRYPTED_COLUMNS,
  getUserGeminiKeys, addUserGeminiKey, removeUserGeminiKey,
  getGeminiKeys, getGeminiKeysForUser, recordKeyUse, addGeminiKey, removeGeminiKey, getUserDefaults, ensureUserDirectories,
};
