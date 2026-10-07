// What each exchange-rate source is called on screen. The case page and the
// receipt page each kept a map of their own: one said "ECB reference rate",
// the other "European Central Bank reference rate", and neither had heard of
// Open Exchange Rates, so a rate from it showed as the raw key. The names are
// main/fx/sources.js's, so the screen and the printed report agree.
const SOURCES = {
  openexchangerates: { name: 'Open Exchange Rates',   long: 'Open Exchange Rates rate' },
  frankfurter:       { name: 'European Central Bank', long: 'European Central Bank reference rate' },
  'open.er-api':     { name: 'ExchangeRate-API',      long: 'ExchangeRate-API daily rate' },
  manual:            { name: 'Set by an admin',       long: 'Rate set by an admin' },
  // Not providers: a line already in the base currency needs no rate at all.
  base:              { name: 'Base currency',         long: 'Base currency' },
  same:              { name: 'Same currency',         long: 'Same currency' },
};

// "European Central Bank", for a list of rates.
export const fxSourceName = key => (SOURCES[key] ? SOURCES[key].name : key || '');
// "European Central Bank reference rate", for a sentence about one rate.
export const fxSourceLong = key => (SOURCES[key] ? SOURCES[key].long : key || '');
