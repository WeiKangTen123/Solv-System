const db = require('../db');
const providers = require('./providers');
const logger = require('../utils/logger');

// The rate for one unit of `from` in `to`, for a date. Cached for good once
// known — a historical reference rate never changes — except today's, which
// providers update through the day and which is re-fetched after an hour.
//
// Priority when several rows exist for a day: a rate finance typed in, then
// the ECB reference rate, then the daily open.er-api rate.
const PRIORITY = { manual: 0, frankfurter: 1, 'open.er-api': 2 };
const TODAY_TTL_MS = 60 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);

function _row(r) {
  if (!r) return null;
  return { from: r.base, to: r.quote, rateDate: r.rate_date, rate: r.rate, source: r.source, fetchedAt: r.fetched_at, providerDate: r.provider_date || r.rate_date, enteredBy: r.entered_by || null };
}

function _cached(from, to, date) {
  const rows = db.prepare('SELECT * FROM fx_rates WHERE base = ? AND quote = ? AND rate_date = ?').all(from, to, date).map(_row);
  rows.sort((a, b) => (PRIORITY[a.source] ?? 9) - (PRIORITY[b.source] ?? 9));
  return rows[0] || null;
}

function _save({ from, to, date, rate, source, providerDate, by = null }) {
  db.prepare(`INSERT INTO fx_rates (base, quote, rate_date, rate, source, fetched_at, provider_date, entered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(base, quote, rate_date, source) DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at, provider_date = excluded.provider_date, entered_by = excluded.entered_by`)
    .run(from, to, date, rate, source, new Date().toISOString(), providerDate || date, by);
  return _cached(from, to, date);
}

async function _fetch(from, to, date) {
  const historical = date < today() ? date : null;      // today or later: latest
  const f = await providers.frankfurter(from, to, historical);
  if (f) return _save({ from, to, date, rate: f.rate, source: f.source, providerDate: f.providerDate });
  const e = await providers.erapi(from, to);
  if (e) return _save({ from, to, date, rate: e.rate, source: e.source, providerDate: e.providerDate });
  logger.warn('No exchange rate from any provider', { from, to, date });
  return null;
}

async function getRate({ from, to, date }) {
  if (!from || !to) return null;
  if (from === to) return { from, to, rateDate: date, rate: 1, source: 'same', fetchedAt: new Date().toISOString(), providerDate: date };
  const day = date || today();
  const hit = _cached(from, to, day);
  if (hit) {
    const stale = hit.source !== 'manual' && day >= today() && Date.now() - Date.parse(hit.fetchedAt) > TODAY_TTL_MS;
    if (!stale) return hit;
  }
  const fresh = await _fetch(from, to, day);
  return fresh || hit || null;
}

function setManualRate({ from, to, date, rate, by }) {
  if (!(Number(rate) > 0)) throw new Error('A rate must be a number above zero');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('Date must be YYYY-MM-DD');
  if (!/^[A-Z]{3}$/.test(String(from || '').toUpperCase()) || !/^[A-Z]{3}$/.test(String(to || '').toUpperCase())) throw new Error('Currencies must be 3-letter codes');
  return _save({ from: String(from).toUpperCase(), to: String(to).toUpperCase(), date, rate: Number(rate), source: 'manual', providerDate: date, by });
}

function deleteManualRate({ from, to, date }) {
  return db.prepare("DELETE FROM fx_rates WHERE base = ? AND quote = ? AND rate_date = ? AND source = 'manual'").run(from, to, date).changes > 0;
}

function listRates({ to, from, since } = {}) {
  const where = [], args = [];
  if (to)    { where.push('quote = ?'); args.push(to); }
  if (from)  { where.push('base = ?'); args.push(from); }
  if (since) { where.push('rate_date >= ?'); args.push(since); }
  return db.prepare(`SELECT * FROM fx_rates ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rate_date DESC, base, source LIMIT 500`).all(...args).map(_row);
}

module.exports = { getRate, setManualRate, deleteManualRate, listRates, TODAY_TTL_MS, PRIORITY };
