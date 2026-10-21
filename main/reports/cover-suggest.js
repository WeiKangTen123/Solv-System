const db = require('../db');

// What the AI would put on a case's cover, worked out from the receipts in it
// rather than asked of the model: the kind, a title, the dates, where it was
// and how many nights. The same receipts always give the same cover, and the
// person can see why (`basis`).
//
// The purpose is never suggested. It is the business reason for the spend,
// which is on no receipt, and a reader that made one up would be putting
// words in the claimant's mouth on a document they sign.

// The country a currency is spent in, for the currencies that have one. The
// euro has no single country, so a euro receipt with no address says nothing
// about where it was.
const CURRENCY_COUNTRY = {
  SGD: 'SG', MYR: 'MY', IDR: 'ID', THB: 'TH', PHP: 'PH', VND: 'VN', INR: 'IN', LKR: 'LK', HKD: 'HK', CNY: 'CN', JPY: 'JP',
  KRW: 'KR', TWD: 'TW', AUD: 'AU', NZD: 'NZ', USD: 'US', GBP: 'GB', CAD: 'CA', CHF: 'CH', AED: 'AE', SAR: 'SA',
};
// A hotel or a flight is travel even at home: a trip to a site in Johor
// paid in ringgit by a Malaysian company is still a trip.
const TRAVEL = new Set(['hotel', 'flight']);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DESTINATION_MAX = 120;   // what the cover route keeps (routes/reports.js)

// Built once: an Intl object costs a fraction of a millisecond each time, and
// a case is suggested on every read that lands in it.
let _names = null;
// "India", "Sri Lanka". Hong Kong and Macao come back as "Hong Kong SAR
// China", which is correct and not what anybody writes on a claim. A code the
// library does not know comes back as itself, and is no name at all.
function countryName(code) {
  const c = _iso2(code);
  if (!c) return null;
  try {
    _names = _names || new Intl.DisplayNames(['en'], { type: 'region' });
    const n = _names.of(c);
    if (!n || n === c || n === 'Unknown Region') return null;
    return n.replace(/ SAR China$/, '');
  } catch { return null; }
}
function _iso2(code) {
  const c = String(code || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}
const _ccy = c => String(c || '').trim().toUpperCase() || null;

// The receipts a cover is made from: read, dated, and not a duplicate of one
// already counted. One dated after today is a misread year far more often
// than a receipt from the future, and would stretch a three-day trip to a
// year; it carries a flag of its own (receipts/flags.js).
function _usable(expenses, today) {
  return (expenses || []).filter(e => e && !['reading', 'duplicate', 'rejected'].includes(e.status)
    && ISO.test(String(e.receiptDate || '')) && !(today && e.receiptDate > today));
}

const _day = iso => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const _days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
// "Sep 2026", "Sep–Oct 2026", "Dec 2026–Jan 2027".
function monthSpan(from, to) {
  const fy = from.slice(0, 4), ty = to.slice(0, 4), fm = MON[Number(from.slice(5, 7)) - 1], tm = MON[Number(to.slice(5, 7)) - 1];
  if (fy === ty && fm === tm) return `${fm} ${fy}`;
  if (fy === ty) return `${fm}–${tm} ${fy}`;
  return `${fm} ${fy}–${tm} ${ty}`;
}
// "4 Sep 2026", "1–4 Sep 2026", "3 Sep – 18 Oct 2026", "28 Dec 2025 – 3 Jan 2026".
function dayRange(from, to) {
  if (from === to) return _day(from);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8, 10))}–${_day(to)}`;
  if (from.slice(0, 4) === to.slice(0, 4)) return `${_day(from).slice(0, -5)} – ${_day(to)}`;
  return `${_day(from)} – ${_day(to)}`;
}
const _lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// Most frequent first; a tie goes to the one seen first, so the same receipts
// always give the same order.
function _ranked(values) {
  const seen = new Map();
  values.forEach((v, i) => {
    if (!v) return;
    const key = v.toLowerCase();
    const t = seen.get(key) || { value: v, n: 0, first: i };
    t.n++; seen.set(key, t);
  });
  return [...seen.values()].sort((a, b) => b.n - a.n || a.first - b.first).map(t => t.value);
}

// { kind, title, periodFrom, periodTo, destination, nights, basis }, or null
// when no receipt in the case is read and dated yet.
function suggestCover(expenses, { baseCurrency = 'SGD', today = null } = {}) {
  const list = _usable(expenses, today).sort((a, b) => a.receiptDate.localeCompare(b.receiptDate));
  if (!list.length) return null;
  const base = _ccy(baseCurrency) || 'SGD';
  const home = CURRENCY_COUNTRY[base] || 'SG';
  const from = list[0].receiptDate, to = list[list.length - 1].receiptDate;

  // Foreign: printed in another country, or paid in another currency. Where
  // it was is the printed country, or failing that the currency's.
  const foreign = [], travel = [], countries = [];
  for (const e of list) {
    const printed = _iso2(e.country);
    const ccy = _ccy(e.currency);
    if (TRAVEL.has(e.docType)) travel.push(e);
    if (!((printed && printed !== home) || (ccy && ccy !== base))) continue;
    foreign.push(e);
    const where = printed ? (printed !== home ? printed : null) : (CURRENCY_COUNTRY[ccy] && CURRENCY_COUNTRY[ccy] !== home ? CURRENCY_COUNTRY[ccy] : null);
    countries.push(where);
  }
  const codes = _ranked(countries);
  const basis = { receipts: list.length, foreign: foreign.length, travel: travel.length, countries: codes,
                  why: foreign.length ? 'foreign' : travel.length ? 'travel' : from.slice(0, 7) === to.slice(0, 7) ? 'month' : 'span' };

  if (foreign.length || travel.length) {
    const names = codes.map(countryName).filter(Boolean);
    // The towns of the receipts abroad; a trip that never left home is named
    // by where its hotel and flights were. A city that is its own country
    // ("Singapore", "Hong Kong") is said once.
    const said = [...names, countryName(home)].filter(Boolean).map(n => n.toLowerCase());
    const cities = (foreign.length ? foreign : travel).map(e => (typeof e.city === 'string' ? e.city.replace(/\s+/g, ' ').trim() : null));
    const towns = _ranked(cities).filter(c => !said.includes(c.toLowerCase())).slice(0, 3);
    let destination = null;
    if (names.length === 1) destination = [...towns, names[0]].join(', ');
    else if (names.length > 1) destination = names.join(', ');
    else if (towns.length) destination = towns.join(', ');
    const span = monthSpan(from, to);
    const title = names.length === 1 ? `${names[0]} trip, ${span}`
      : names.length === 2 ? `${names[0]} and ${names[1]} trip, ${span}`
      : `Trip, ${span}`;
    return { kind: 'trip', title, periodFrom: from, periodTo: to, destination: destination ? destination.slice(0, DESTINATION_MAX) : null,
             nights: _days(from, to), basis };
  }
  if (from.slice(0, 7) === to.slice(0, 7)) {
    const y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
    return { kind: 'period', title: `${MONTH[m - 1]} ${y} claims`, periodFrom: `${from.slice(0, 7)}-01`,
             periodTo: `${from.slice(0, 7)}-${String(_lastDay(y, m)).padStart(2, '0')}`, destination: null, nights: null, basis };
  }
  return { kind: 'case', title: `Receipts, ${dayRange(from, to)}`, periodFrom: from, periodTo: to, destination: null, nights: null, basis };
}

// The owner's open case whose dates already hold every dated receipt of this
// one, for a draft to offer "Move them there" instead of becoming a second
// case for the same trip. The narrowest wins: a receipt from a week in Pune
// belongs to the Pune trip before the quarter's catch-all. Only an open case
// is offered: another draft's dates are the AI's guess, not a case anybody
// made, and two drafts would offer each other.
function findMatch(caseId, userId) {
  if (!caseId || !userId) return null;
  const dates = db.prepare(`SELECT receipt_date AS d FROM expenses
                            WHERE report_id = ? AND status NOT IN ('reading', 'duplicate', 'rejected') AND receipt_date IS NOT NULL`)
    .all(caseId).map(r => r.d).filter(d => ISO.test(String(d))).sort();
  if (!dates.length) return null;
  const row = db.prepare(`SELECT id, number, title, period_from, period_to FROM expense_reports
                          WHERE user_id = ? AND id != ? AND status = 'open'
                            AND period_from IS NOT NULL AND period_to IS NOT NULL
                            AND period_from <= ? AND period_to >= ?
                          ORDER BY julianday(period_to) - julianday(period_from), created_at DESC LIMIT 1`)
    .get(userId, caseId, dates[0], dates[dates.length - 1]);
  return row ? { id: row.id, number: row.number, title: row.title, periodFrom: row.period_from, periodTo: row.period_to } : null;
}

module.exports = { suggestCover, findMatch, countryName, monthSpan, dayRange, CURRENCY_COUNTRY };
