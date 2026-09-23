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

function sanitize(u) {
  if (!u) return null;
  return {
    id: u.id, companyId: u.company_id, email: u.email, role: u.role, name: u.name || null,
    employeeId: u.employee_id || null, department: u.department || null,
    createdAt: u.created_at, lastSeenAt: u.last_seen_at || null, online: isOnline(u.last_seen_at),
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
};
const CRED_TO_KEY = Object.fromEntries(Object.entries(CRED_COLUMNS).map(([k, v]) => [v, k]));
const ENCRYPTED_COLUMNS = new Set(['xero_client_secret', 'xero_oauth_client_secret', 'xero_oauth_refresh_token']);

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
  if (role && !ROLES.includes(role)) throw new Error(`Unknown role "${role}"`);
  const hash = await bcrypt.hash(password, 10);
  const create = db.transaction(() => {
    if (_rawByEmail(email)) throw new Error('Email already exists');
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

async function validatePassword(email, password) {
  const raw = _rawByEmail(email);
  if (!raw) return null;
  return (await bcrypt.compare(password, raw.password)) ? sanitize(raw) : null;
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

async function setPassword(id, password) {
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(await bcrypt.hash(password, 10), id);
}

function getAllUsers(companyId) {
  return db.prepare('SELECT * FROM users WHERE company_id = ? ORDER BY created_at').all(companyId).map(sanitize);
}
function deleteUser(id) { db.prepare('DELETE FROM users WHERE id = ?').run(id); }
function readUsers() { return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(sanitize); }

// ── Reader keys (company-wide) ──────────────────────────────────────────────
function getGeminiKeys(companyId) {
  return db.prepare('SELECT id, api_key, label, created_at FROM company_gemini_keys WHERE company_id = ? ORDER BY id').all(companyId)
    .map(r => ({ id: r.id, apiKey: decrypt(r.api_key), label: r.label, createdAt: r.created_at }));
}
function getGeminiKeysForUser(userId) {
  const u = findById(userId);
  return u ? getGeminiKeys(u.companyId) : [];
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
  ROLES, DEFAULT_TIMEZONE, DEFAULT_REPORT_COLUMNS,
  hasUsers, findById, findByEmail, createUser, validatePassword, updateUser, setPassword, getAllUsers, deleteUser, readUsers,
  touchLastSeen, isOnline, sanitize,
  getCompany, createCompany, updateCompany, getCompanyConfig, saveCompanyConfig, ENCRYPTED_COLUMNS,
  getGeminiKeys, getGeminiKeysForUser, addGeminiKey, removeGeminiKey, getUserDefaults, ensureUserDirectories,
};
