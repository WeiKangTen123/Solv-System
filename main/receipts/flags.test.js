const { flagsFor } = require('./flags');
const { currencyNote } = require('./read-receipt');

// A receipt that is fine in every way, as the store hands it out; each test
// breaks one thing.
const good = (extra = {}) => ({
  status: 'review-needed', merchant: 'Toast Box', receiptDate: '2026-09-04', currency: 'SGD', total: 10.9, tax: 0.9,
  lines: [{ amount: 10.9, baseAmount: 10.9, fxSource: 'base' }], fxPending: false, duplicateOf: null, errorMsg: null, aiRead: { total: 10.9 },
  ...extra,
});
const opts = { baseCurrency: 'SGD', today: '2026-10-21' };
const codes = (e, report = null, o = opts) => flagsFor(e, report, o).map(f => f.code);

describe('receipts/flags', () => {
  test('a receipt with nothing wrong has no flags', () => {
    expect(flagsFor(good(), { periodFrom: '2026-09-01', periodTo: '2026-09-30' }, opts)).toEqual([]);
    expect(flagsFor(good(), null, {})).toEqual([]);
  });

  test('a receipt still being read has none, whatever is on it', () => {
    expect(flagsFor(good({ status: 'reading', merchant: null, total: 0, lines: [] }), null, opts)).toEqual([]);
    expect(flagsFor(null, null, opts)).toEqual([]);
  });

  test('no amount: no total, or no lines to price', () => {
    expect(flagsFor(good({ total: 0, tax: null, aiRead: null, lines: [] }), null, opts)).toEqual([{ code: 'no-amount', level: 'red', text: 'No amount yet.', field: 'total' }]);
    expect(codes(good({ lines: [] }))).toEqual(['no-amount']);
  });

  test('no merchant, and no date', () => {
    expect(flagsFor(good({ merchant: '' }), null, opts)).toEqual([{ code: 'no-merchant', level: 'red', text: 'No merchant.', field: 'merchant' }]);
    expect(flagsFor(good({ receiptDate: null }), null, opts)).toEqual([{ code: 'no-date', level: 'red', text: 'No date.', field: 'receiptDate' }]);
  });

  test('lines that do not add up to the total', () => {
    const f = flagsFor(good({ lines: [{ amount: 4, baseAmount: 4 }, { amount: 5, baseAmount: 5 }] }), null, opts);
    expect(f).toEqual([{ code: 'lines-off', level: 'red', text: 'The lines add up to 9.00, not the total of 10.90.', field: 'lines' }]);
  });

  test('no exchange rate yet, with the reason when there is one', () => {
    const e = good({ currency: 'INR', total: 1000, tax: null, aiRead: null, lines: [{ amount: 1000, baseAmount: null }], fxPending: true });
    expect(flagsFor(e, null, opts)).toEqual([{ code: 'no-rate', level: 'red', text: 'No exchange rate to SGD yet.', field: 'currency' }]);
    e.lines[0].fxCheck = 'No rate is published for INR on that day.';
    expect(flagsFor(e, null, opts)[0].text).toBe('No SGD amount yet: No rate is published for INR on that day.');
  });

  test('outside the case\'s dates, either end, or either end alone', () => {
    const r = { periodFrom: '2026-09-05', periodTo: '2026-09-10' };
    expect(flagsFor(good(), r, opts)).toEqual([{ code: 'outside-case', level: 'yellow', text: 'The date is outside the case\'s dates.', field: 'receiptDate' }]);
    expect(codes(good({ receiptDate: '2026-09-11' }), r)).toEqual(['outside-case']);
    expect(codes(good({ receiptDate: '2026-09-05' }), r)).toEqual([]);
    expect(codes(good({ receiptDate: '2026-09-10' }), r)).toEqual([]);
    expect(codes(good(), { periodFrom: '2026-09-05', periodTo: null })).toEqual(['outside-case']);
    expect(codes(good(), { periodFrom: null, periodTo: null })).toEqual([]);
  });

  test('a possible duplicate, and a certain one', () => {
    expect(flagsFor(good({ duplicateOf: 'x' }), null, opts)).toEqual([{ code: 'possible-duplicate', level: 'yellow', text: 'This may be a receipt already uploaded.' }]);
    expect(flagsFor(good({ duplicateOf: 'x', status: 'duplicate' }), null, opts)[0].text).toMatch(/is a duplicate/);
  });

  test('a currency the reader assumed', () => {
    const f = flagsFor(good({ errorMsg: `Faded. ${currencyNote('SGD')}` }), null, opts);
    expect(f).toEqual([{ code: 'currency-assumed', level: 'yellow', text: 'No currency is printed on the receipt, so SGD was assumed.', field: 'currency' }]);
    expect(codes(good({ errorMsg: 'Faded.' }))).toEqual([]);
  });

  test('GST that is not 9/109 of a Singapore total from 2024', () => {
    // 109.00 holds 9.00 of GST; two per cent either way, or five cents on a small bill, is rounding
    expect(codes(good({ total: 109, tax: 9, lines: [{ amount: 109, baseAmount: 109 }], aiRead: null }))).toEqual([]);
    expect(codes(good({ total: 109, tax: 9.17, lines: [{ amount: 109, baseAmount: 109 }], aiRead: null }))).toEqual([]);
    expect(codes(good({ total: 109, tax: 9.2, lines: [{ amount: 109, baseAmount: 109 }], aiRead: null }))).toEqual(['gst-mismatch']);
    expect(codes(good({ total: 2.18, tax: 0.22, lines: [{ amount: 2.18, baseAmount: 2.18 }], aiRead: null }))).toEqual([]);
    expect(codes(good({ total: 2.18, tax: 0.24, lines: [{ amount: 2.18, baseAmount: 2.18 }], aiRead: null }))).toEqual(['gst-mismatch']);
    const f = flagsFor(good({ total: 107, tax: 7, lines: [{ amount: 107, baseAmount: 107 }], aiRead: null }), null, opts);
    expect(f).toEqual([{ code: 'gst-mismatch', level: 'yellow', text: 'The GST of 7.00 is not 9% of the total; about 8.83 was expected.', field: 'tax' }]);
    // 7% was the rate in 2023; no tax shown, another currency: nothing to say
    expect(codes(good({ total: 107, tax: 7, receiptDate: '2023-12-31', lines: [{ amount: 107, baseAmount: 107 }], aiRead: null }))).toEqual([]);
    expect(codes(good({ tax: null }))).toEqual([]);
    expect(codes(good({ tax: 0 }))).toEqual([]);
    expect(codes(good({ currency: 'MYR', tax: 0.6, fxPending: false }))).toEqual([]);
  });

  test('a total that is not what the reader read', () => {
    const f = flagsFor(good({ total: 12, tax: null, lines: [{ amount: 12, baseAmount: 12 }] }), null, opts);
    expect(f).toEqual([{ code: 'edited-amount', level: 'yellow', text: 'The total was changed from the 10.90 the reader read.', field: 'total' }]);
    expect(codes(good({ aiRead: { total: '10.90' } }))).toEqual([]);
    expect(codes(good({ aiRead: { total: null } }))).toEqual([]);
    expect(codes(good({ aiRead: {} }))).toEqual([]);
  });

  test('a date in the future, as the company\'s day sees it', () => {
    expect(flagsFor(good({ receiptDate: '2026-10-22' }), null, opts)).toEqual([{ code: 'future-date', level: 'yellow', text: 'The date is in the future.', field: 'receiptDate' }]);
    expect(codes(good({ receiptDate: '2026-10-21' }))).toEqual([]);
    expect(codes(good({ receiptDate: '2026-10-22' }), null, { baseCurrency: 'SGD' })).toEqual([]);   // no day given, nothing to compare
  });

  test('red comes before yellow, and several can be true at once', () => {
    const f = flagsFor(good({ merchant: null, duplicateOf: 'x', receiptDate: '2026-12-01' }), { periodFrom: '2026-09-01', periodTo: '2026-09-30' }, opts);
    expect(f.map(x => [x.level, x.code])).toEqual([['red', 'no-merchant'], ['yellow', 'outside-case'], ['yellow', 'possible-duplicate'], ['yellow', 'future-date']]);
  });
});
