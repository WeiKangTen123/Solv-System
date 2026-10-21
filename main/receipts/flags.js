const { linesReconcile, toCents } = require('../store/expenses');
const { formatAmount } = require('../utils/money');

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

// Singapore's GST since 1 January 2024: 9%, so the tax inside a total is 9/109
// of it. A total with a service charge carries GST on the charge too, which
// keeps the ratio, so it holds for a restaurant bill as well.
const GST_FROM = '2024-01-01';
const GST_SHARE = 9 / 109;
// Rounding on a long bill drifts a few cents; more than 2%, or more than five
// cents on a small one, is not rounding.
const GST_SLACK = { share: 0.02, cents: 5 };

function _currencyNote() {
  // Loaded when first asked: read-receipt pulls in the reader and the PDF
  // tools, which nothing here needs until a receipt with a note is shown.
  return require('./read-receipt').CURRENCY_NOTE_RE;
}

function flagsFor(expense, report = null, { baseCurrency = 'SGD', today = null } = {}) {
  const e = expense;
  if (!e || e.status === 'reading') return [];
  const out = [];
  const add = (level, code, text, field) => out.push({ code, level, text, ...(field ? { field } : {}) });
  const lines = Array.isArray(e.lines) ? e.lines : [];
  const total = Number(e.total) || 0;

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
  if (e.errorMsg && _currencyNote().test(e.errorMsg)) {
    add('yellow', 'currency-assumed', `No currency is printed on the receipt, so ${e.currency || baseCurrency} was assumed.`, 'currency');
  }
  const tax = e.tax === null || e.tax === undefined || e.tax === '' ? null : Number(e.tax);
  if (e.currency === 'SGD' && e.receiptDate && e.receiptDate >= GST_FROM && tax > 0 && total > 0) {
    const expected = total * GST_SHARE;
    if (Math.abs(tax - expected) > Math.max(expected * GST_SLACK.share, GST_SLACK.cents / 100)) {
      add('yellow', 'gst-mismatch', `The GST of ${formatAmount(tax)} is not 9% of the total; about ${formatAmount(expected)} was expected.`, 'tax');
    }
  }
  const read = e.aiRead && e.aiRead.total;
  if (read !== null && read !== undefined && read !== '' && Number.isFinite(Number(read)) && toCents(read) !== toCents(total)) {
    add('yellow', 'edited-amount', `The total was changed from the ${formatAmount(read)} the reader read.`, 'total');
  }
  if (today && e.receiptDate && e.receiptDate > today) add('yellow', 'future-date', 'The date is in the future.', 'receiptDate');
  return out;
}

module.exports = { flagsFor, GST_FROM };
