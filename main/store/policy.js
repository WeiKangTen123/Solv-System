const db = require('../db');
const { newId } = require('../utils/ids');
const { fail } = require('../utils/http-error');
const { CATEGORY_NAMES, canonicalCategory } = require('../intake/categories');
const { isoDate } = require('../intake/document');
const { countryName, dayRange } = require('../reports/cover-suggest');
const { toCents, toDollars } = require('./expenses');

// The company's policy, as an admin sets it, and the per-diem rates.
//
// Nothing here approves or refuses anything: Solv records claims and does not
// route them. A limit, a maximum age and weekends only decide which yellow
// "have a look" flags a receipt carries (receipts/flags.js). The mileage rate
// and the per-diem rates are what reports/allowances.js works a claim out at.
//
// Every value is checked on the way in, with a message a person can act on,
// and checked again on the way out: a row edited by hand keeps the default
// for whatever no longer reads, rather than putting NaN into every flag.

const DEFAULTS = Object.freeze({
  mileageRatePerKm: null,      // in the base currency; none until an admin sets one
  travelDayPct: 100,           // the share of a day's rate the first and last day of a trip get
  categoryLimits: Object.freeze({}),   // { "<category>": amount in the base currency, per receipt }
  maxAgeDays: null,
  flagWeekends: false,
});
const KEYS = Object.keys(DEFAULTS);
const _keyList = `${KEYS.slice(0, -1).join(', ')} and ${KEYS[KEYS.length - 1]}`;

// The most a limit or a day's rate may be. A per diem in rupiah or dong runs
// to millions a day; a figure past this is a typing slip.
const MAX_AMOUNT = 100000000;

// A number as a person or a form sends it: 0.6 or "0.6", not true, [] or "".
function _num(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
const _empty = v => v === null || v === '';

// One rule per setting, used for what an admin sends and for what is read
// back, so the two cannot disagree. Each returns the clean value or throws a
// 400 that says what it takes.
const RULES = {
  mileageRatePerKm(v) {
    if (_empty(v)) return null;
    const n = _num(v);
    const rounded = n === null ? null : Math.round(n * 10000) / 10000;
    if (rounded === null || rounded <= 0 || rounded > 100) fail(400, 'The mileage rate must be an amount per km above 0 and at most 100, or empty for none.');
    return rounded;
  },
  travelDayPct(v) {
    if (_empty(v)) return DEFAULTS.travelDayPct;
    const n = _num(v);
    if (n === null || n < 0 || n > 100) fail(400, 'The travel-day share must be a percentage from 0 to 100.');
    return Math.round(n * 100) / 100;
  },
  // Merged into what is there: setting the Meals limit leaves the Lodging one
  // alone, and null takes one away. null for the whole map clears them all.
  categoryLimits(v, current = {}) {
    if (v === null) return {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'The category limits must be a list of category and amount, such as { "Meals": 50 }.');
    const next = { ...current };
    for (const [name, amount] of Object.entries(v)) {
      const cat = canonicalCategory(name);
      if (!cat) fail(400, `Not a category: ${String(name).slice(0, 60)}. Limits are set for the categories in the list: ${CATEGORY_NAMES.join(', ')}.`);
      if (_empty(amount)) { delete next[cat]; continue; }
      const n = _num(amount);
      if (n === null || n < 0 || n > MAX_AMOUNT) fail(400, `The limit for ${cat} must be an amount from 0 up, or empty to remove it.`);
      next[cat] = toDollars(toCents(n));
    }
    return next;
  },
  maxAgeDays(v) {
    if (_empty(v)) return null;
    const n = _num(v);
    if (n === null || !Number.isInteger(n) || n < 1 || n > 3650) fail(400, 'The maximum age must be a whole number of days from 1 to 3650, or empty for none.');
    return n;
  },
  flagWeekends(v) {
    if (typeof v !== 'boolean') fail(400, 'Flagging weekend receipts must be true or false.');
    return v;
  },
};

// Read on every receipt shown, a case page of forty receipts asking forty
// times, so each company's policy is kept once read. Every write goes through
// setPolicy, which drops it; there is one server process (ecosystem.config.js).
const _cache = new Map();

function _freeze(p) {
  return Object.freeze({ ...p, categoryLimits: Object.freeze({ ...p.categoryLimits }) });
}

function _load(companyId) {
  const row = db.prepare('SELECT json FROM company_policy WHERE company_id = ?').get(companyId);
  let stored = {};
  try { stored = row && row.json ? JSON.parse(row.json) : {}; } catch { stored = {}; }
  const out = { ...DEFAULTS, categoryLimits: {} };
  if (!stored || typeof stored !== 'object') return out;
  for (const k of KEYS) {
    if (stored[k] === undefined) continue;
    try { out[k] = RULES[k](stored[k], {}); } catch { /* the default stands */ }
  }
  return out;
}

// { mileageRatePerKm, travelDayPct, categoryLimits, maxAgeDays, flagWeekends },
// the defaults under whatever has been set. Frozen: it is the cached copy.
function getPolicy(companyId) {
  if (!companyId) return _freeze(DEFAULTS);
  let p = _cache.get(companyId);
  if (!p) { p = _freeze(_load(companyId)); _cache.set(companyId, p); }
  return p;
}

// When the policy was last changed, and by whom, for the settings page.
function policyChange(companyId) {
  const row = db.prepare(`SELECT p.updated_at, p.updated_by, u.name, u.email FROM company_policy p
                          LEFT JOIN users u ON u.id = p.updated_by WHERE p.company_id = ?`).get(companyId);
  return row ? { updatedAt: row.updated_at || null, updatedBy: row.updated_by ? { id: row.updated_by, name: row.name || row.email || null } : null }
             : { updatedAt: null, updatedBy: null };
}

// Only the settings named in the patch change. A key nobody knows is refused
// rather than kept: "maxAge" saved quietly would look set and do nothing.
function setPolicy(companyId, patch, actorId = null) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'Send the policy settings as an object.');
  const unknown = Object.keys(patch).filter(k => !KEYS.includes(k));
  if (unknown.length) fail(400, `Unknown policy setting: ${unknown.slice(0, 3).map(k => String(k).slice(0, 40)).join(', ')}. The settings are ${_keyList}.`);
  const current = getPolicy(companyId);
  const next = { ...current, categoryLimits: { ...current.categoryLimits } };
  for (const k of Object.keys(patch)) next[k] = RULES[k](patch[k], next[k]);
  db.prepare(`INSERT INTO company_policy (company_id, json, updated_by, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(company_id) DO UPDATE SET json = excluded.json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(companyId, JSON.stringify(next), actorId || null, new Date().toISOString());
  _cache.delete(companyId);
  return getPolicy(companyId);
}

// ── Per-diem rates ───────────────────────────────────────────────────────────
function _rate(row) {
  if (!row) return null;
  return {
    id: row.id, companyId: row.company_id, country: row.country, countryName: countryName(row.country) || row.country,
    currency: row.currency, dailyAmount: toDollars(row.daily_cents), effectiveFrom: row.effective_from,
    createdBy: row.created_by || null, createdAt: row.created_at,
  };
}

// By country, the newest rate of each first.
function listRates(companyId) {
  return db.prepare('SELECT * FROM per_diem_rates WHERE company_id = ? ORDER BY country, effective_from DESC').all(companyId).map(_rate);
}

// A rate is added, never edited: the day a rate changes is a new row from
// that date, and the old one still prices the days before it.
function addRate({ companyId, country, currency, dailyAmount, effectiveFrom, createdBy = null } = {}) {
  const c = typeof country === 'string' ? country.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(c) || !countryName(c)) fail(400, 'The country must be a two-letter country code, such as IN for India.');
  const ccy = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(ccy)) fail(400, 'The currency must be a three-letter code, such as INR.');
  const n = _num(dailyAmount);
  const cents = n === null ? null : toCents(n);
  if (!(cents > 0) || n > MAX_AMOUNT) fail(400, 'The amount a day must be above 0.');
  const from = typeof effectiveFrom === 'string' ? isoDate(effectiveFrom, { allowFuture: true }) : null;
  if (!from) fail(400, 'Say the date the rate applies from, as YYYY-MM-DD.');
  if (db.prepare('SELECT 1 FROM per_diem_rates WHERE company_id = ? AND country = ? AND effective_from = ?').get(companyId, c, from)) {
    fail(409, `There is already a rate for ${countryName(c)} from ${dayRange(from, from)}. Delete that one first to change it.`);
  }
  const id = newId();
  db.prepare(`INSERT INTO per_diem_rates (id, company_id, country, currency, daily_cents, effective_from, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, companyId, c, ccy, cents, from, createdBy || null, new Date().toISOString());
  return _rate(db.prepare('SELECT * FROM per_diem_rates WHERE id = ?').get(id));
}

function deleteRate(companyId, id) {
  return db.prepare('DELETE FROM per_diem_rates WHERE company_id = ? AND id = ?').run(companyId, String(id)).changes === 1;
}

// The rate for one day in one country: the latest that had started by then.
function rateFor(companyId, country, date) {
  if (!companyId || !country || !date) return null;
  return _rate(db.prepare(`SELECT * FROM per_diem_rates WHERE company_id = ? AND country = ? AND effective_from <= ?
                           ORDER BY effective_from DESC LIMIT 1`).get(companyId, String(country).toUpperCase(), date));
}

// Drops every cached policy, for a test that writes the table directly.
function _clearCache() { _cache.clear(); }

module.exports = { getPolicy, setPolicy, policyChange, listRates, addRate, deleteRate, rateFor, DEFAULTS, _clearCache };
