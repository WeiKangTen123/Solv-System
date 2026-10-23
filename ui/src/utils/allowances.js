// Per diem and mileage on the screen: claims with no receipt behind them,
// worked out by the server from the company's own rates
// (main/reports/allowances.js). The server works the amount out and the page
// never sends one; what is here is what the dialogs show BEFORE asking (the
// days, the rate, the total), which country a per diem would be for, and the
// words a receipt-less row is shown with.
//
// The rules are the server's, copied: a preview that disagreed with what the
// server then adds would be worse than none. main/scripts/ui-allowances.test.js
// holds the two to the same answers.
//
// No imports, so that test can load it from source.

export const ALLOWANCE_LABEL = { per_diem: 'Per diem', mileage: 'Mileage' };

// 'per_diem', 'mileage', or null for a receipt with a file behind it.
export function allowanceOf(e) {
  return e && Object.prototype.hasOwnProperty.call(ALLOWANCE_LABEL, e.source) ? e.source : null;
}

// What a receipt-less row says under its label: the server's description
// ("India: 4 days × INR 4,000" under "Per diem"). Its first rows began with
// the label as well ("Per diem, India: …"), which is still taken off.
export function allowanceWords(e) {
  const d = String((e && e.description) || '').trim();
  return d.replace(/^Per diem,\s*/i, '');
}

// ── Countries ───────────────────────────────────────────────────────────────
// The names the server says them by (reports/cover-suggest.js countryName):
// the browser's own list of regions, in English, with "Hong Kong SAR China"
// said as Hong Kong.
let _names = null;
export function countryName(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  try {
    _names = _names || new Intl.DisplayNames(['en'], { type: 'region' });
    const n = _names.of(c);
    if (!n || n === c || n === 'Unknown Region') return null;
    return n.replace(/ SAR China$/, '');
  } catch { return null; }
}

// Every two-letter code the browser has a name for, by name: what the
// per-diem rate form offers. Built once, when first asked.
let _countries = null;
export function countryOptions() {
  if (_countries) return _countries;
  const out = [];
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(65 + i, 65 + j);
      const name = countryName(code);
      // The browser also names groupings ("European Union", "world"); a per
      // diem is for a country, and the server refuses nothing it can name,
      // so only the codes ISO keeps for groupings are left out.
      if (name && !/^(EU|EZ|UN|QO|XA|XB|ZZ)$/.test(code)) out.push({ code, name });
    }
  }
  _countries = out.sort((a, b) => a.name.localeCompare(b.name));
  return _countries;
}

// A country's own currency, for the rate form to offer once a country is
// picked. The server's list (reports/cover-suggest.js), turned round, and a
// few more of the places people travel to.
export const CURRENCY_COUNTRY = {
  SGD: 'SG', MYR: 'MY', IDR: 'ID', THB: 'TH', PHP: 'PH', VND: 'VN', INR: 'IN', LKR: 'LK', HKD: 'HK', CNY: 'CN', JPY: 'JP',
  KRW: 'KR', TWD: 'TW', AUD: 'AU', NZD: 'NZ', USD: 'US', GBP: 'GB', CAD: 'CA', CHF: 'CH', AED: 'AE', SAR: 'SA',
};
const COUNTRY_CURRENCY = {
  ...Object.fromEntries(Object.entries(CURRENCY_COUNTRY).map(([ccy, c]) => [c, ccy])),
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', IE: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR',
  BD: 'BDT', MM: 'MMK', KH: 'KHR', LA: 'LAK', BN: 'BND', MO: 'MOP', NP: 'NPR', PK: 'PKR', QA: 'QAR', OM: 'OMR', KW: 'KWD',
  BH: 'BHD', SE: 'SEK', NO: 'NOK', DK: 'DKK', ZA: 'ZAR', BR: 'BRL', MX: 'MXN', TR: 'TRY',
};
export const currencyOf = country => COUNTRY_CURRENCY[String(country || '').toUpperCase()] || '';

// Every name the browser knows, to a code, for a destination typed as
// "Pune, India".
let _byName = null;
function _countryInText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (!_byName) {
    _byName = new Map();
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 26; j++) {
        const code = String.fromCharCode(65 + i, 65 + j);
        const name = countryName(code);
        if (name) _byName.set(name.toLowerCase(), code);
      }
    }
  }
  const parts = text.split(/[,;/]/).map(s => s.trim().toLowerCase()).filter(Boolean).reverse();
  for (const p of parts) if (_byName.has(p)) return _byName.get(p);
  return null;
}

function _mostCommon(values) {
  const n = new Map();
  for (const v of values) if (v) n.set(v, (n.get(v) || 0) + 1);
  let best = null;
  for (const [v, c] of n) if (!best || c > n.get(best)) best = v;
  return best;
}

// The country a trip's per diem is for when the person does not choose one:
// where most of its foreign receipts were printed; failing that, the country
// of the foreign currency they were paid in; failing that, a country named in
// the destination. Home is never guessed. The server's perDiemCountry; the
// dialog sends what it shows, so the two cannot end up apart.
export function guessPerDiemCountry(report, baseCurrency) {
  const base = String(baseCurrency || 'SGD').toUpperCase();
  const home = CURRENCY_COUNTRY[base] || 'SG';
  const usable = ((report && report.expenses) || []).filter(e => !allowanceOf(e) && !['reading', 'duplicate', 'rejected'].includes(e.status));
  const printed = usable.map(e => (typeof e.country === 'string' ? e.country.toUpperCase() : null)).filter(c => c && /^[A-Z]{2}$/.test(c) && c !== home);
  const byCurrency = usable.map(e => (e.currency && e.currency !== base ? CURRENCY_COUNTRY[e.currency] : null)).filter(c => c && c !== home);
  return _mostCommon(printed) || _mostCommon(byCurrency) || _countryInText(report && report.destination);
}

// ── Days ────────────────────────────────────────────────────────────────────
// Calendar days as YYYY-MM-DD, counted in UTC so no time zone moves them.
const _ms = d => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d, n) => new Date(_ms(d) + n * 86400000).toISOString().slice(0, 10);
export const dayCount = (from, to) => Math.round((_ms(to) - _ms(from)) / 86400000) + 1;

// The rate for one day in one country: the latest that had started by then.
// `rates` is GET /company/per-diem-rates's list.
export function rateOn(rates, country, date) {
  let best = null;
  for (const r of rates || []) {
    if (r.country !== country || r.effectiveFrom > date) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best;
}

export const MAX_PER_DIEM_DAYS = 366;
const _pct = n => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _day = d => { const [y, m, dd] = String(d).split('-'); return `${Number(dd)} ${MONTHS[Number(m) - 1]} ${y}`; };

// What "Add per diem" would add, worked out as the server will: each day of
// the trip at the rate for that day, the first and last at the travel-day
// share (a one-day trip at it once). Returns { days, currency, total, runs,
// share } where `runs` are the rates with the days each priced, or
// { problem } saying why there would be none, in the server's words.
export function perDiemPreview({ rates, country, from, to, travelDayPct = 100 }) {
  const name = countryName(country) || country;
  if (!country) return { problem: 'Choose the country the per diem is for.' };
  if (!from || !to) return { problem: 'Set the trip\'s first and last day before adding a per diem.' };
  const count = dayCount(from, to);
  if (!(count >= 1)) return { problem: 'The trip ends before it starts. Correct its dates first.' };
  if (count > MAX_PER_DIEM_DAYS) return { problem: `A per diem covers at most ${MAX_PER_DIEM_DAYS} days, and this trip is ${count}. Check its dates.` };
  const share = (Number.isFinite(Number(travelDayPct)) ? Number(travelDayPct) : 100) / 100;
  const days = [];
  for (let i = 0; i < count; i++) {
    const date = addDays(from, i);
    const rate = rateOn(rates, country, date);
    if (!rate) {
      const any = (rates || []).filter(x => x.country === country);
      if (!any.length) return { problem: `There is no per-diem rate for ${name}. An admin adds per-diem rates in Settings.` };
      const first = any.reduce((a, b) => (a.effectiveFrom < b.effectiveFrom ? a : b));
      return { problem: `The per-diem rate for ${name} starts on ${_day(first.effectiveFrom)}, after this trip's first day (${_day(date)}). An admin can add an earlier rate in Settings.` };
    }
    days.push({ date, weight: count === 1 || i === 0 || i === count - 1 ? share : 1, rate });
  }
  const currencies = [...new Set(days.map(d => d.rate.currency))];
  if (currencies.length > 1) return { problem: `The per-diem rates for ${name} during this trip are in ${currencies.join(' and ')}, and one per diem is in one currency. Ask an admin to keep ${name}'s rates in one currency.` };
  const cents = Math.round(days.reduce((s, d) => s + Math.round(Number(d.rate.dailyAmount) * 100) * d.weight, 0));
  if (!(cents > 0)) return { problem: `With the first and last day at ${_pct(share * 100)}, a trip of ${count} day${count === 1 ? '' : 's'} has no per diem.` };
  const runs = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && last.amount === d.rate.dailyAmount) { last.to = d.date; last.days++; }
    else runs.push({ amount: d.rate.dailyAmount, from: d.date, to: d.date, days: 1 });
  }
  return { days: count, currency: currencies[0], total: cents / 100, runs, share: share * 100 };
}

// What a drive comes to at the company's rate, as the server rounds it.
// null until there is a distance and a rate to work with.
export function mileagePreview({ km, returnTrip = false, rate }) {
  const k = Number(km), r = Number(rate);
  if (!(k > 0) || !(r > 0)) return null;
  const rounded = Math.round(k * 100) / 100;
  return { km: rounded, legs: returnTrip ? 2 : 1, total: Math.round(rounded * (returnTrip ? 2 : 1) * r * 100) / 100 };
}
export const MAX_KM = 5000;

// ── Flags ───────────────────────────────────────────────────────────────────
// The server says a meal on a per-diem day is "already paid for by the case's
// per diem". Where the page has the case in hand the flag names which one,
// so the person knows what they are being pointed at.
export function nameFlags(flags, expenses) {
  if (!Array.isArray(flags) || !flags.some(f => f.code === 'per-diem-meal')) return flags;
  const pd = (expenses || []).find(x => allowanceOf(x) === 'per_diem');
  const where = pd && countryName(pd.country);
  if (!where) return flags;
  return flags.map(f => (f.code === 'per-diem-meal' ? { ...f, text: `The per diem for ${where} in this case already pays for meals on this day.` } : f));
}

// The same for every receipt of a case view (GET /reports/:id), as it comes
// in, so every place the page shows a flag says the same words.
export function nameCaseFlags(view) {
  const list = view && view.report && view.report.expenses;
  if (!Array.isArray(list) || !list.some(e => allowanceOf(e) === 'per_diem')) return view;
  return { ...view, report: { ...view.report, expenses: list.map(e => ({ ...e, flags: nameFlags(e.flags, list) })) } };
}
