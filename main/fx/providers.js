const axios  = require('axios');
const logger = require('../utils/logger');

// Two free providers, tried in order by rates.js. Both answer "how many units
// of `to` for one unit of `from`" — the direction every stored rate uses.
const TIMEOUT = 5000;

// European Central Bank reference rates. Historical by date; a weekend or
// holiday answers with the last business day, and says which in `date`.
async function frankfurter(from, to, date = null) {
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

// ExchangeRate-API's open endpoint: 160+ currencies, one daily rate, no history.
async function erapi(from, to) {
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

module.exports = { frankfurter, erapi, TIMEOUT };
