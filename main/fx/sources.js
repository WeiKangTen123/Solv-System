// What each exchange-rate source is called. `name` is the short form the
// live board shows; `long` and `via` are what the printed report says. They
// were kept in two files that did not know about each other, and the report
// had never heard of Open Exchange Rates.
const SOURCES = {
  openexchangerates: { name: 'Open Exchange Rates', long: 'Open Exchange Rates rate', via: 'openexchangerates.org' },
  frankfurter:       { name: 'European Central Bank', long: 'European Central Bank reference rate', via: 'Frankfurter' },
  'open.er-api':     { name: 'ExchangeRate-API', long: 'ExchangeRate-API daily rate', via: 'open.er-api.com' },
  manual:            { name: 'Set by an admin', long: 'Rate set by an admin', via: 'Solv' },
};
const pick = field => Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v[field]]));

module.exports = { SOURCES, SOURCE_NAME: pick('name'), SOURCE_LONG: pick('long'), SOURCE_VIA: pick('via') };
