const axios  = require('axios');
const logger = require('../utils/logger');

// Two free providers, tried in order by rates.js. Both answer "how many units
// of `to` for one unit of `from`" — the direction every stored rate uses.
const TIMEOUT = 5000;

// Both providers round to a fixed number of decimal places, not to a number of
// significant figures, so a currency worth a very small fraction of the base
// comes back with almost no precision: the ECB prints one rupiah as 0.000072
// SGD, which is two figures. A ten-million-rupiah hotel bill converted with
// that lands SGD 2.69 away from the right answer, and a twelve-million-dong
// one is out by SGD 0.95.
//
// Asked the other way round the same provider says 13,941.2 rupiah to the
// dollar — six figures — so below this threshold we ask that question instead
// and invert the answer. It costs one extra request per currency per day,
// after which the rate is cached like any other.
const THIN_RATE = 0.1;

// ── European Central Bank reference rates ─────────────────────────────────
// Historical by date; a weekend or holiday answers with the last business day,
// and says which in `date`.
async function _frankfurterOne(from, to, date = null) {
  const url = `https://api.frankfurter.dev/v1/${date || 'latest'}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
  try {
    const { data } = await axios.get(url, { timeout: TIMEOUT });
    const rate = data && data.rates && Number(data.rates[to]);
    if (!(rate > 0)) return null;
    return { rate, providerDate: data.date || date, source: 'frankfurter' };
  } catch (err) {
    logger.info('frankfurter had no rate', { from, to, date, error: err.message });
    return null;
  }
}

async function frankfurter(from, to, date = null) {
  const direct = await _frankfurterOne(from, to, date);
  if (direct && direct.rate >= THIN_RATE) return direct;
  const back = await _frankfurterOne(to, from, date);
  if (back && back.rate > 0) return { rate: 1 / back.rate, providerDate: back.providerDate, source: 'frankfurter' };
  return direct;
}

// ── ExchangeRate-API's open endpoint ──────────────────────────────────────
// 160+ currencies, one daily rate, no history.
async function _erapiOne(from, to) {
  const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;
  try {
    const { data } = await axios.get(url, { timeout: TIMEOUT });
    if (!data || data.result !== 'success') return null;
    const rate = Number(data.rates && data.rates[to]);
    if (!(rate > 0)) return null;
    const providerDate = data.time_last_update_utc ? new Date(data.time_last_update_utc).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    return { rate, providerDate, source: 'open.er-api' };
  } catch (err) {
    logger.info('open.er-api had no rate', { from, to, error: err.message });
    return null;
  }
}

async function erapi(from, to) {
  const direct = await _erapiOne(from, to);
  if (direct && direct.rate >= THIN_RATE) return direct;
  const back = await _erapiOne(to, from);
  if (back && back.rate > 0) return { rate: 1 / back.rate, providerDate: back.providerDate, source: 'open.er-api' };
  return direct;
}

// ── Every currency at once, for the live board ────────────────────────────
// One request returns the provider's whole table against one base, so the
// board costs the same to refresh for two currencies as for twenty. A table
// is { source, base, providerDate, providerTime, rates: { XXX: units of XXX
// for one unit of base } }, and crossRate() reads any pair out of it.
//
// Asked against the company's base and inverted, which is the direction that
// keeps the precision: SGD → INR is 75.216, five figures, where INR → SGD is
// printed as 0.0133, three. Same reasoning as THIN_RATE above.

async function frankfurterAll(base) {
  try {
    const { data } = await axios.get(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}`, { timeout: TIMEOUT });
    if (!data || !data.rates || !Object.keys(data.rates).length) return null;
    return { source: 'frankfurter', base, providerDate: data.date || null, providerTime: null, rates: data.rates };
  } catch (err) {
    logger.info('frankfurter table unavailable', { base, error: err.message });
    return null;
  }
}

async function erapiAll(base) {
  try {
    const { data } = await axios.get(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, { timeout: TIMEOUT });
    if (!data || data.result !== 'success' || !data.rates) return null;
    const at = data.time_last_update_utc ? new Date(data.time_last_update_utc) : null;
    const iso = at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
    return { source: 'open.er-api', base, providerDate: iso ? iso.slice(0, 10) : null, providerTime: iso, rates: data.rates };
  } catch (err) {
    logger.info('open.er-api table unavailable', { base, error: err.message });
    return null;
  }
}

// Open Exchange Rates: keyed, and the one that moves within the day — hourly
// on the free plan, every 30 or 5 minutes on paid ones. The free plan is fixed
// to a US-dollar base, so it is always asked in dollars and every pair is a
// cross through them; that works on every plan and costs one request.
//
// Unlike the free feeds this THROWS, with Open Exchange Rates' own words,
// because the caller is either an admin checking a key they just pasted or
// the scheduler, which logs it; neither is served by a silent null.
async function oxrAll(appId) {
  if (!appId) throw new Error('No Open Exchange Rates App ID');
  try {
    const { data } = await axios.get(`https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(appId)}`, { timeout: TIMEOUT });
    if (!data || !data.rates || !data.base) throw new Error('Open Exchange Rates answered without rates');
    const at = Number(data.timestamp) > 0 ? new Date(Number(data.timestamp) * 1000).toISOString() : null;
    return { source: 'openexchangerates', base: data.base, providerDate: at ? at.slice(0, 10) : null, providerTime: at, rates: data.rates };
  } catch (err) {
    const body = err.response && err.response.data;
    const said = body && (body.description || body.message);
    throw new Error(said ? `Open Exchange Rates: ${said}` : err.message);
  }
}

// One unit of `from` in `to`, read from a table, or null when the table does
// not carry both. The table's own base is worth exactly 1 of itself.
function crossRate(table, from, to) {
  if (!table || !table.rates) return null;
  const per = c => (c === table.base ? 1 : Number(table.rates[c]));
  const f = per(from), t = per(to);
  if (!(f > 0) || !(t > 0)) return null;
  return t / f;
}

module.exports = { frankfurter, erapi, frankfurterAll, erapiAll, oxrAll, crossRate, TIMEOUT, THIN_RATE };
