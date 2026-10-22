const db = require('../db');
const { linesReconcile, toCents } = require('../store/expenses');
const policyStore = require('../store/policy');
const { formatAmount } = require('../utils/money');
const { addDays } = require('../utils/zone-date');
const logger = require('../utils/logger');

// What is worth saying about one receipt, worked out each time it is shown
// and never stored: a flag that was saved would go stale the moment somebody
// fixed what it was about.
//
//   red     stops a claim. The same things claiming refuses for
//           (reports/workflow.js markClaimed), said on the receipt they are
//           about instead of as one refusal for the whole case.
//   yellow  "have a look". Nothing stops; somebody should glance at it.
//
// Each is { code, level, text, field? }: `code` for the page to key on,
// `text` for a person to read, `field` the receipt field it is about, for the
// page to point at. A receipt still being read has no flags: whatever is on
// it is about to be replaced.
//
// The company's policy (store/policy.js) adds four yellow ones: over a
// category's limit, older than the maximum age, dated on a weekend, and a
// meal on a day the case's per diem already pays for. The policy is read
// here, from a cache, so no page that shows flags has to pass it in.

// Singapore's GST since 1 January 2024: 9%, so the tax inside a total is 9/109
// of it. A total with a service charge carries GST on the charge too, which
// keeps the ratio, so it holds for a restaurant bill as well.
const GST_FROM = '2024-01-01';
const GST_SHARE = 9 / 109;
// Rounding on a long bill drifts a few cents; more than 2%, or more than five
// cents on a small one, is not rounding.
const GST_SLACK = { share: 0.02, cents: 5 };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// A per diem and a mileage claim have no receipt behind them
// (reports/allowances.js): nothing was read, so nothing was assumed, misread
// or changed from a reading, and the flags about the reader say nothing true
// of them. A per diem is the company's own rate for the trip's days, so a
// limit or the weekday of its first day says nothing about it either.
const PER_DIEM = 'per_diem';
const ALLOWANCES = new Set([PER_DIEM, 'mileage']);

function _currencyNote() {
  // Loaded when first asked: read-receipt pulls in the reader and the PDF
  // tools, which nothing here needs until a receipt with a note is shown.
  return require('./read-receipt').CURRENCY_NOTE_RE;
}

// The policy of the receipt's company, or none. A receipt must still show if
// the policy cannot be read; it shows without the policy's flags.
function _policy(e, report) {
  const companyId = e.companyId || (report && report.companyId) || null;
  if (!companyId) return null;
  try { return policyStore.getPolicy(companyId); }
  catch (err) { logger.warn('Company policy not read for the flags', { companyId, error: err.message }); return null; }
}

// Whether the case holds a per diem. The case page hands over the case with
// its receipts; a list hands over only the case's dates, and then it is one
// indexed query, asked only for a meal inside those dates.
function _hasPerDiem(e, report) {
  if (Array.isArray(report.expenses)) return report.expenses.some(x => x.source === PER_DIEM && x.id !== e.id);
  if (!e.reportId) return false;
  return !!db.prepare('SELECT 1 FROM expenses WHERE report_id = ? AND source = ? AND id != ? LIMIT 1').get(e.reportId, PER_DIEM, e.id || '');
}

// The receipt's base amount for each category its lines carry: a hotel folio
// with a dinner on it is Lodging and Meals, and each is held to its own
// limit. A line with no base amount yet has its own red flag and is left out.
function _baseByCategory(e, lines) {
  const out = new Map();
  for (const l of lines) {
    const cents = toCents(l.baseAmount);
    if (cents === null) continue;
    const cat = l.category || e.category || 'Other';
    out.set(cat, (out.get(cat) || 0) + cents);
  }
  return out;
}

const _days = n => `${n} day${n === 1 ? '' : 's'}`;

function flagsFor(expense, report = null, { baseCurrency = 'SGD', today = null } = {}) {
  const e = expense;
  if (!e || e.status === 'reading') return [];
  const out = [];
  const add = (level, code, text, field) => out.push({ code, level, text, ...(field ? { field } : {}) });
  const lines = Array.isArray(e.lines) ? e.lines : [];
  const total = Number(e.total) || 0;
  const allowance = ALLOWANCES.has(e.source);

  // ── Red: a claim with any of these is refused ──
  if (!(total > 0) || !lines.length) add('red', 'no-amount', 'No amount yet.', 'total');
  if (!e.merchant) add('red', 'no-merchant', 'No merchant.', 'merchant');
  if (!e.receiptDate) add('red', 'no-date', 'No date.', 'receiptDate');
  if (total > 0 && lines.length && !linesReconcile(lines, toCents(total))) {
    const sum = lines.reduce((s, l) => s + (toCents(l.amount) || 0), 0) / 100;
    add('red', 'lines-off', `The lines add up to ${formatAmount(sum)}, not the total of ${formatAmount(total)}.`, 'lines');
  }
  if (lines.length && e.fxPending) {
    const why = lines.find(l => l.fxCheck);
    add('red', 'no-rate', why ? `No ${baseCurrency} amount yet: ${why.fxCheck}` : `No exchange rate to ${baseCurrency} yet.`, 'currency');
  }

  // ── Yellow: have a look ──
  if (report && e.receiptDate && ((report.periodFrom && e.receiptDate < report.periodFrom) || (report.periodTo && e.receiptDate > report.periodTo))) {
    add('yellow', 'outside-case', 'The date is outside the case\'s dates.', 'receiptDate');
  }
  if (e.duplicateOf) {
    add('yellow', 'possible-duplicate', e.status === 'duplicate' ? 'This is a duplicate of a receipt already uploaded.' : 'This may be a receipt already uploaded.');
  }
  if (!allowance && e.errorMsg && _currencyNote().test(e.errorMsg)) {
    add('yellow', 'currency-assumed', `No currency is printed on the receipt, so ${e.currency || baseCurrency} was assumed.`, 'currency');
  }
  const tax = e.tax === null || e.tax === undefined || e.tax === '' ? null : Number(e.tax);
  if (!allowance && e.currency === 'SGD' && e.receiptDate && e.receiptDate >= GST_FROM && tax > 0 && total > 0) {
    const expected = total * GST_SHARE;
    if (Math.abs(tax - expected) > Math.max(expected * GST_SLACK.share, GST_SLACK.cents / 100)) {
      add('yellow', 'gst-mismatch', `The GST of ${formatAmount(tax)} is not 9% of the total; about ${formatAmount(expected)} was expected.`, 'tax');
    }
  }
  const read = e.aiRead && e.aiRead.total;
  if (!allowance && read !== null && read !== undefined && read !== '' && Number.isFinite(Number(read)) && toCents(read) !== toCents(total)) {
    add('yellow', 'edited-amount', `The total was changed from the ${formatAmount(read)} the reader read.`, 'total');
  }
  if (today && e.receiptDate && e.receiptDate > today) add('yellow', 'future-date', 'The date is in the future.', 'receiptDate');

  // ── Yellow, from the company's policy ──
  const policy = _policy(e, report);
  if (!policy) return out;
  const limits = policy.categoryLimits || {};
  if (e.source !== PER_DIEM && Object.keys(limits).length && lines.length) {
    const byCat = _baseByCategory(e, lines);
    const over = [...byCat].filter(([cat, cents]) => limits[cat] !== undefined && cents > toCents(limits[cat]));
    if (over.length === 1 && byCat.size === 1) {
      const [[cat, cents]] = over;
      add('yellow', 'over-limit', `${baseCurrency} ${formatAmount(cents / 100)} is over the ${cat} limit of ${baseCurrency} ${formatAmount(limits[cat])} a receipt.`, 'total');
    } else if (over.length) {
      // Several categories on one receipt: each said with its own part.
      add('yellow', 'over-limit', `Over the limit a receipt: ${over.map(([cat, cents]) => `${cat} ${baseCurrency} ${formatAmount(cents / 100)} (limit ${formatAmount(limits[cat])})`).join('; ')}.`, 'lines');
    }
  }
  if (policy.maxAgeDays && today && e.receiptDate && ISO.test(e.receiptDate) && e.receiptDate < addDays(today, -policy.maxAgeDays)) {
    add('yellow', 'too-old', `It is more than ${_days(policy.maxAgeDays)} old; the company's policy is ${_days(policy.maxAgeDays)}.`, 'receiptDate');
  }
  if (policy.flagWeekends && e.source !== PER_DIEM && e.receiptDate && ISO.test(e.receiptDate)) {
    const day = new Date(`${e.receiptDate}T00:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) add('yellow', 'weekend', `It is dated on a ${day === 6 ? 'Saturday' : 'Sunday'}.`, 'receiptDate');
  }
  const meal = e.category === 'Meals' || lines.some(l => l.category === 'Meals');
  if (meal && e.source !== PER_DIEM && report && report.periodFrom && report.periodTo && e.receiptDate
      && e.receiptDate >= report.periodFrom && e.receiptDate <= report.periodTo && _hasPerDiem(e, report)) {
    add('yellow', 'per-diem-meal', 'The case\'s per diem already pays for meals on this day.', 'category');
  }
  return out;
}

module.exports = { flagsFor, GST_FROM };
