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

module.exports = { frankfurter, erapi, TIMEOUT, THIN_RATE };
