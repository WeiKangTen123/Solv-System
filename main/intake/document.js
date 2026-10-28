// The one shape every document takes on its way into the system, and the one
// set of helpers that clean values into it.
//
// Three extractors feed this app — a text LLM for emailed PDFs, a vision LLM
// for photographed receipts, and a regex-plus-verifier for the AR template —
// and until this file each had its own vocabulary (vendorName / merchant /
// contactName for the same thing) and its own copies of the date, number and
// currency cleaning. Two of those copies had drifted: one treated an unreadable
// date as "today", the other as null. Everything downstream — dedup, the row
// builder, Xero submission — now reads one shape, and the extractors adapt to
// it rather than the other way round.
//
// A Document is what an extractor returns. It is not yet a row: it carries no
// id, status, or source, and no user. record.js turns it into one.

// The codes detectCurrency() will recognise printed on a document, from the one
// list in currencies.js. The AI reader is not held to them — whatever
// three-letter code it reads is accepted, and the rate providers cover about
// 160 currencies — but a text document has to be matched against something.
const { CURRENCY_CODES } = require('./currencies');

// ── Numbers ─────────────────────────────────────────────────────────────────

// Never widens. A total is the field a person is least likely to re-check, so
// a value that is not a clean finite number is dropped rather than coerced.
//
// Amounts arrive as printed in the country they were spent in. "12,50" is
// twelve euros fifty, not 1,250; "1.234,56" is a German thousand; "Rp
// 1.250.000" is a million and a quarter rupiah, and "1 234,56" French. The
// separator printed last is the decimal one when both appear; one alone is a
// decimal point unless three digits follow it (the thousands of "1,234"), or
// it is printed more than once. India groups by twos ("1,00,000"), so only the
// last group need be three digits. A discount printed "(5.00)", or with a
// till's trailing minus "12.80-", is negative. Two numbers in one value
// ("2 x 4.50") are not one amount, and are nothing.
const ZERO_DECIMAL_MARK = /\bRp\b|\bIDR\b|\bVND\b|₫|\bJPY\b|¥|\bKRW\b|₩/i;
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[−‒–]/g, '-').trim();
  // Number('') is 0, so a value with no digit in it at all — a name that landed
  // in the amount column — used to come out as a silent zero. It is nothing.
  const runs = text.match(/\d[\d.,'   ]*/g);
  if (!runs || runs.length !== 1) return null;
  let core = runs[0].replace(/[.,'   ]+$/, '');
  const at = text.indexOf(core);
  const negative = /-/.test(text.slice(0, at)) || /^\(.*\)$/.test(text) || /^-/.test(text.slice(at + core.length).trim());

  // Spaces and apostrophes inside a number only ever group thousands.
  if (/['   ]/.test(core)) {
    const groups = core.split(/['   ]/);
    if (groups.slice(1).some(g => !/^\d{3}(?:[.,]\d*)?$/.test(g))) return null;
    core = groups.join('');
  }
  const dots = (core.match(/\./g) || []).length, commas = (core.match(/,/g) || []).length;
  let plain;
  if (dots && commas) {
    const dec = core.lastIndexOf('.') > core.lastIndexOf(',') ? '.' : ',';
    plain = core.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (dots || commas) {
    const sep = commas ? ',' : '.';
    const groups = core.split(sep);
    // One dot before three digits stays a decimal point (a dinar has three
    // places) unless the value names a currency that has no decimals.
    const last = groups[groups.length - 1];
    const thousands = groups.length > 2 || (last.length === 3 && (sep === ',' || ZERO_DECIMAL_MARK.test(text)));
    if (thousands) {
      if (!/^\d{1,3}$/.test(groups[0]) || last.length !== 3 || groups.slice(1, -1).some(g => !/^\d{2,3}$/.test(g))) return null;
      plain = groups.join('');
    } else plain = groups.join('.');
  } else plain = core;
  if (!/^\d+(\.\d+)?$/.test(plain)) return null;
  const n = Number(plain);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

function money(value) {
  const n = num(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

// ── Dates ───────────────────────────────────────────────────────────────────

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Strict: accepts only a real YYYY-MM-DD that is not in the future. A model
// that answers "2026-13-45", or dates a receipt next year, has misread it, and
// null is more honest than a guess.
// allowFuture: a trip that has not happened yet has a real date too.
function isoDate(value, { allowFuture = false } = {}) {
  if (!value || typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const parsed = new Date(Date.UTC(y, mo - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== mo - 1 || parsed.getUTCDate() !== d) return null;
  if (!allowFuture && parsed.getTime() > Date.now() + 86400000) return null;
  return value.trim();
}

// Lenient: reads what a person typed. "10/08/2026" is day-first (Singapore),
// "2026-08-10" is ISO, "10 Aug 2026" is whatever Date() accepts. Returns null
// when nothing usable is there — the caller decides what to fall back to,
// because "today" is right for a due date and wrong for an invoice date.
function parseDate(raw) {
  if (!raw) return null;
  try {
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    if (!trimmed.includes('/')) {
      const direct = new Date(trimmed);
      if (!isNaN(direct)) return localDateStr(direct);
    }
    const parts = trimmed.split(/[/\-.]/);
    if (parts.length < 3) return null;
    const d = parts[0].length === 4
      ? new Date(`${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`)
      : new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`);
    return isNaN(d) ? null : localDateStr(d);
  } catch {
    return null;
  }
}

// ── Currency ────────────────────────────────────────────────────────────────

// A real ISO 4217 code, or nothing. Any three letters used to pass, so a
// reader that answered "RMB" or "XXX" stored it, and no rate provider could
// price it. The list is the one the runtime itself knows (about 160), wider
// than the rate providers', so a currency nobody here has met still passes.
// What receipts print in place of a code, and means only one currency, is
// mapped to it: RMB is the yuan, RM the ringgit, S$ the Singapore dollar. A
// bare "$" or "¥" is not here; several countries print each.
const ISO_CURRENCIES = (() => {
  try { return new Set(Intl.supportedValuesOf('currency')); } catch { return null; }
})();
const CURRENCY_ALIASES = {
  RMB: 'CNY', YEN: 'JPY', NTD: 'TWD', RM: 'MYR', RP: 'IDR', EURO: 'EUR', EUROS: 'EUR',
  'S$': 'SGD', 'SG$': 'SGD', 'US$': 'USD', 'A$': 'AUD', 'AU$': 'AUD', 'C$': 'CAD', 'CA$': 'CAD',
  'HK$': 'HKD', 'NT$': 'TWD', 'NZ$': 'NZD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '₩': 'KRW', '₱': 'PHP', '฿': 'THB', '₫': 'VND',
};
function currencyCode(value) {
  if (!value || typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (CURRENCY_ALIASES[code]) return CURRENCY_ALIASES[code];
  if (!/^[A-Z]{3}$/.test(code)) return null;
  return !ISO_CURRENCIES || ISO_CURRENCIES.has(code) ? code : null;
}

// Reads a document's own currency from its text rather than assuming the
// account's default. Null, not a guess, when the text does not say.
function detectCurrency(text) {
  if (!text) return null;
  const labeled = text.match(/Currency\s*:\s*([A-Z]{3})\b/i);
  if (labeled && CURRENCY_CODES.includes(labeled[1].toUpperCase())) return labeled[1].toUpperCase();
  const nearAmount = text.match(new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b\\s*\\$?\\s*[\\d,]+\\.?\\d*`));
  if (nearAmount) return nearAmount[1].toUpperCase();
  // Symbols that name a currency. A bare "$" does not — it is used by USD, SGD,
  // AUD, CAD, HKD and NZD — so it is deliberately not handled. Nor is a bare
  // "¥", which China and Japan both print.
  // Each symbol only where it starts: "US$" contains "S$" and "CA$" contains
  // "A$", and both were read as SGD and AUD.
  if (/(^|[^A-Z])US\$/.test(text)) return 'USD';
  if (/(^|[^A-Z])CA?\$/.test(text)) return 'CAD';
  if (/(^|[^A-Z])S\$/.test(text))  return 'SGD';
  if (/(^|[^A-Z])A\$/.test(text))  return 'AUD';
  if (/NT\$/.test(text))       return 'TWD';
  if (/HK\$/.test(text))       return 'HKD';
  if (/£/.test(text))          return 'GBP';
  if (/€/.test(text))          return 'EUR';
  if (/₹/.test(text))          return 'INR';
  if (/₫|VND\b/.test(text))    return 'VND';
  if (/฿/.test(text))          return 'THB';
  if (/₱/.test(text))          return 'PHP';
  if (/₩/.test(text))          return 'KRW';
  if (/د\.إ/.test(text))       return 'AED';
  if (/\bRp\s?[\d.]/.test(text)) return 'IDR';
  if (/RM\s?\d/.test(text))    return 'MYR';
  if (/¥/.test(text))          return 'JPY';
  return null;
}

// ── Tax ─────────────────────────────────────────────────────────────────────

// "9%", "GST 9%", "VAT (20%)" → 9 / 9 / 20. Free text with no figure ("GST",
// "-", blank) → null: it carries no computable amount, so no tax is assumed.
function parseTaxPercent(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

// ── The Document ────────────────────────────────────────────────────────────

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// One line item from any vocabulary the readers have used: the template's
// { description, unitAmount, discountRate, taxPercent }, the bill model's
// { description, quantity, unitPrice, amount }, the receipt reader's
// { description, quantity, unitAmount (a unit price), lineTotal }.
//
// The stored unitAmount is always the LINE total — the figure Xero must
// receive — and a quantity above one rides in the text as "6 × 1.60", since
// there is no quantity column. Three readers each did this their own way
// and this function did not know quantity at all.
function normaliseLineItem(li) {
  if (!li || typeof li !== 'object') return null;
  const description = str(li.description ?? li.name, 4000);
  const unit  = money(li.unitPrice ?? li.unitAmount ?? li.price);
  const qty   = num(li.quantity);
  const line  = money(li.lineTotal ?? li.amount ?? li.total);
  const unitAmount = line !== null ? line
    : (unit !== null && qty > 1 ? Math.round(unit * qty * 100) / 100 : unit);
  if (!description && unitAmount === null) return null;
  const label    = description || 'Item';
  const folded   = qty > 1 && unit !== null && unit > 0
    ? `${label} — ${Number.isInteger(qty) ? qty : qty.toFixed(2)} × ${unit.toFixed(2)}`
    : label;
  const discount = num(li.discountRate);
  // A discount, a promotion or a rounding down is printed as a negative line
  // and stays one: made 0, the lines of a supermarket bill with "2ND UNIT 50%
  // OFF -3.45" came to 3.45 more than was paid, and the reader put the
  // difference on whatever line was largest.
  return {
    description:  folded,
    unitAmount:   unitAmount !== null ? unitAmount : 0,
    discountRate: discount !== null && discount >= 0 ? discount : 0,
    taxPercent:   parseTaxPercent(li.taxPercent ?? li.tax) ?? (num(li.taxPercent) ?? null),
  };
}

module.exports = {
  CURRENCY_CODES,
  num, money, isoDate, parseDate,
  currencyCode, detectCurrency, parseTaxPercent,
  normaliseLineItem,
};
