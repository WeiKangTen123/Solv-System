// Money/percentage formatting shared by the dashboard panels. Extracted so the
// Overview and Revenue panels format identically to the tabs that predate them —
// two copies of "how we render a negative" is how reports start disagreeing.

// Each currency to its own minor unit: JPY 9,000, not JPY 9,000.00 (and
// three places for the dinars). Anything Intl does not know gets two.
const _digits = new Map();
function minorDigits(currency) {
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return 2;
  if (!_digits.has(currency)) {
    let d = 2;
    try { d = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch { /* not a currency Intl knows */ }
    _digits.set(currency, d);
  }
  return _digits.get(currency);
}
export function fmtMoney(n, currency) {
  const v = Number(n || 0);
  const d = minorDigits(currency);
  return `${currency ? currency + ' ' : ''}${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

// Compact form for chart labels and tiles, where two decimals are noise.
export function fmtMoneyShort(n, currency) {
  const v = Number(n || 0);
  const abs = Math.abs(v);
  const unit = abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'K'] : [1, ''];
  const num = (v / unit[0]).toFixed(abs >= 1e3 && abs / unit[0] < 100 ? 1 : 0).replace(/\.0$/, '');
  return `${currency ? currency + ' ' : ''}${num}${unit[1]}`;
}

// Takes a FRACTION (0.16), not a percentage.
export function fmtPct(fraction, dp = 1) { return `${(Number(fraction || 0) * 100).toFixed(dp)}%`; }

// Report cells: a dash for zero (matching Xero's own reports, where 0 and "no
// activity" look the same) and parentheses for negatives.
export function fmtCell(n) {
  const v = Number(n || 0);
  if (v === 0) return '-';
  const abs = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${abs})` : abs;
}

// An exchange rate printed to six significant figures. The stored rate keeps
// every digit the provider gave — one rupiah is 0.0000717308657915501 Singapore
// dollars, and the conversion needs all of it — but showing that implies a
// precision nobody has, and it will not fit in a table cell either.
export function fmtRate(r) {
  const n = Number(r);
  if (!Number.isFinite(n) || n === 0) return String(r ?? '');
  const fixed = n.toPrecision(6);
  return fixed.includes('e') ? String(n) : fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// ── Calendar dates ──────────────────────────────────────────────────────────
// A receipt date or a case's from/to is a day on a calendar, stored as
// YYYY-MM-DD, not a moment in time. Read through new Date('2026-09-02') it is
// midnight UTC, which is still 1 Sep in New York: so these never make a Date
// of one. The digits are read as they are and printed as they are.
//
// This module has no imports on purpose: main/scripts/ui-format-dates.test.js
// loads it from source under jest, which cannot import an ES module here.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// { y, m, d } from "2026-09-02" (anything after the date, such as a time, is
// ignored), or null for a blank or a date that is not on the calendar.
function _ymd(s) {
  const hit = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? '').trim());
  if (!hit) return null;
  const y = +hit[1], m = +hit[2], d = +hit[3];
  if (m < 1 || m > 12 || d < 1 || d > _daysIn(y, m)) return null;
  return { y, m, d };
}
function _daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}
const _key = p => p.y * 10000 + p.m * 100 + p.d;
const _full = p => `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;

// "2 Sep" this year, "2 Sep 2025" any other: a list of this year's receipts
// does not need the year on every row, and last December's must not pass for
// this one's. `today` (YYYY-MM-DD) is for tests; `withYear` always adds it.
export function fmtDay(date, { today, withYear = false } = {}) {
  const p = _ymd(date);
  if (!p) return '—';
  const t = _ymd(today);
  const thisYear = t ? t.y : new Date().getFullYear();
  return withYear || p.y !== thisYear ? _full(p) : `${p.d} ${MONTHS[p.m - 1]}`;
}

// A case's dates, said once: "1–4 Sep 2026", "28 Sep – 2 Oct 2026",
// "30 Dec 2026 – 2 Jan 2027", and "Oct 2026" for exactly one whole month
// (which a Month case always is). One end missing reads "From …" or
// "Until …"; neither is "—". Ends given the wrong way round are put right
// rather than printed as "4–1 Sep".
export function fmtDateRange(from, to) {
  let a = _ymd(from), b = _ymd(to);
  if (!a && !b) return '—';
  if (!b) return `From ${_full(a)}`;
  if (!a) return `Until ${_full(b)}`;
  if (_key(a) > _key(b)) [a, b] = [b, a];
  if (_key(a) === _key(b)) return _full(a);
  if (a.y === b.y && a.m === b.m) {
    if (a.d === 1 && b.d === _daysIn(b.y, b.m)) return `${MONTHS[a.m - 1]} ${a.y}`;
    return `${a.d}–${b.d} ${MONTHS[a.m - 1]} ${a.y}`;
  }
  if (a.y === b.y) return `${a.d} ${MONTHS[a.m - 1]} – ${_full(b)}`;
  return `${_full(a)} – ${_full(b)}`;
}
