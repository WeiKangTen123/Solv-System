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

  // This file's database has no tables: the policy cannot be read, and the
  // receipt still shows with every other flag.
  test('a policy that cannot be read leaves the other flags as they were', () => {
    expect(codes(good({ companyId: 'c1', merchant: null }))).toEqual(['no-merchant']);
  });
});

describe('receipts/flags, from what the reader saw', () => {
  // A receipt read with checks (aiRead.checks, read-receipt.js) that found nothing.
  const none = { subtotalMismatch: null, chargedTwice: [], people: [], adjusted: null, dateOrder: null };
  const read = (checks, extra = {}) => good({ aiRead: { total: 10.9, checks: { ...none, ...checks } }, ...extra });

  test('checks that found nothing, or a receipt read before there were checks, say nothing', () => {
    expect(codes(read({}))).toEqual([]);
    expect(codes(good({ aiRead: { total: 10.9 } }))).toEqual([]);
    expect(codes(good({ aiRead: null }))).toEqual([]);
  });

  test('split-people names the other people on the lines, and goes when their lines do', () => {
    const lines = [{ amount: 5.9, baseAmount: 5.9 }, { amount: 3, baseAmount: 3, onBehalfOf: 'Tan Suan Kuan' }, { amount: 2, baseAmount: 2, onBehalfOf: 'Tan Suan Kuan' }];
    expect(flagsFor(good({ lines }), null, opts)).toEqual([{ code: 'split-people', level: 'yellow', text: 'Split between you and Tan Suan Kuan: check each person\'s lines.', field: 'lines' }]);
    const three = [{ amount: 4.9, baseAmount: 4.9 }, { amount: 3, baseAmount: 3, onBehalfOf: 'Lim Wei Jie' }, { amount: 3, baseAmount: 3, onBehalfOf: 'Rahman Aisha' }];
    expect(flagsFor(good({ lines: three }), null, opts)[0].text).toBe('Split between you, Lim Wei Jie and Rahman Aisha: check each person\'s lines.');
    expect(codes(good({ lines: [{ amount: 10.9, baseAmount: 10.9 }], aiRead: { total: 10.9, checks: { ...none, people: ['Tan Suan Kuan'] } } }))).toEqual([]);
  });

  test('subtotal-mismatch, in any currency, while the figures are the ones read', () => {
    const e = read({ subtotalMismatch: { subtotal: 2780, tax: 300, total: 3058 } }, { currency: 'JPY', subTotal: 2780, tax: 300, total: 3058, lines: [{ amount: 3058, baseAmount: 27.4 }], aiRead: undefined });
    e.aiRead = { total: 3058, checks: { ...none, subtotalMismatch: { subtotal: 2780, tax: 300, total: 3058 } } };
    expect(flagsFor(e, null, opts)).toEqual([{ code: 'subtotal-mismatch', level: 'yellow', text: 'The subtotal of 2,780.00 and the tax of 300.00 do not come to the total of 3,058.00, even with the charges on the receipt; check the figures.', field: 'total' }]);
    // Somebody corrected the tax: they have looked.
    expect(codes({ ...e, tax: 278 })).toEqual([]);
  });

  test('charged-twice names the charge and how often it appears', () => {
    const f = flagsFor(read({ chargedTwice: [{ description: 'MoMo Cafe Dinner Food', amount: 1296.25, count: 2 }] }), null, opts);
    expect(f).toEqual([{ code: 'charged-twice', level: 'yellow', text: 'MoMo Cafe Dinner Food, 1,296.25, appears twice on the receipt, so it may have been billed twice; check with the merchant.', field: 'lines' }]);
    const two = flagsFor(read({ chargedTwice: [{ description: 'Dinner', amount: 50, count: 3 }, { description: 'Soda', amount: 5, count: 2 }] }), null, opts);
    expect(two[0].text).toBe('Dinner, 50.00, appears 3 times and Soda, 5.00, appears twice on the receipt, so they may have been billed twice; check with the merchant.');
    // The folio's own codes give way to what the charge was and its check number.
    const folio = flagsFor(read({ chargedTwice: [{ description: 'MoMo Cafe Dinner Food Room# 110 : CHECK# 11603631 [oneha089]', amount: 1296.25, count: 2 }] }), null, opts);
    expect(folio[0].text).toBe('MoMo Cafe Dinner Food (check 11603631), 1,296.25, appears twice on the receipt, so it may have been billed twice; check with the merchant.');
  });

  test('lines-adjusted says by how much, and which way', () => {
    expect(flagsFor(read({ adjusted: { amount: 20, pct: 15.2 } }), null, opts)).toEqual([{ code: 'lines-adjusted', level: 'yellow',
      text: 'The items read came to 20.00 less than the total (15.2%), so the lines were made to match it; check them against the receipt.', field: 'lines' }]);
    expect(flagsFor(read({ adjusted: { amount: -4, pct: 3.1 } }), null, opts)[0].text).toMatch(/^The items read came to 4\.00 more than the total \(3\.1%\)/);
  });

  test('date-order names the other reading, until the date is changed', () => {
    const e = read({ dateOrder: { read: '2026-09-04', other: '2026-04-09' } });
    expect(flagsFor(e, null, opts)).toEqual([{ code: 'date-order', level: 'yellow', text: 'The date was read month first, as 4 Sep 2026; read day first it would be 9 Apr 2026. Check it on the receipt.', field: 'receiptDate' }]);
    expect(codes({ ...e, receiptDate: '2026-04-09' })).toEqual([]);
  });

  test('a per diem or mileage claim has none of them', () => {
    const all = { subtotalMismatch: { subtotal: 1, tax: 1, total: 10.9 }, chargedTwice: [{ description: 'x', amount: 1, count: 2 }], people: ['A'], adjusted: { amount: 1, pct: 9 }, dateOrder: { read: '2026-09-04', other: '2026-04-09' } };
    const lines = [{ amount: 10.9, baseAmount: 10.9, onBehalfOf: 'A' }];
    expect(codes(good({ source: 'per_diem', lines, subTotal: 1, tax: 1, aiRead: { checks: all } }))).toEqual([]);
    expect(codes(good({ source: 'mileage', lines, subTotal: 1, tax: 1, aiRead: { checks: all } }))).toEqual([]);
    expect(codes(good({ lines, subTotal: 1, tax: 1, aiRead: { total: 10.9, checks: all } }))).toEqual(['gst-mismatch', 'split-people', 'subtotal-mismatch', 'charged-twice', 'lines-adjusted', 'date-order']);
  });
});

describe('receipts/flags, from the company policy', () => {
  let flags, policy, users, companyId;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); policy = require('../store/policy'); flags = require('./flags');
    companyId = (await users.createUser({ email: 'a@solv.sg', password: 'password123' })).companyId;
  });
  const set = patch => policy.setPolicy(companyId, patch, null);
  const mine = extra => good({ companyId, category: 'Meals', lines: [{ category: 'Meals', amount: 10.9, baseAmount: 10.9 }], ...extra });
  const pcodes = (e, report = null, o = opts) => flags.flagsFor(e, report, o).map(f => f.code);
  // A hotel folio: the room, and a dinner charged to it.
  const folio = (room, dinner) => mine({ category: 'Lodging', total: room + dinner, tax: null, aiRead: null,
    lines: [{ category: 'Lodging', amount: room, baseAmount: room }, { category: 'Meals', amount: dinner, baseAmount: dinner }] });

  test('a policy with nothing set says nothing', () => {
    expect(pcodes(mine({ receiptDate: '2020-09-05' }), { periodFrom: null, periodTo: null, expenses: [{ id: 'p', source: 'per_diem' }] }, { ...opts, today: '2026-10-21' })).toEqual([]);
  });

  test('over a category\'s limit: the receipt\'s amount in the base currency', () => {
    set({ categoryLimits: { Meals: 10 } });
    expect(flags.flagsFor(mine(), null, opts)).toEqual([{ code: 'over-limit', level: 'yellow', text: 'SGD 10.90 is over the Meals limit of SGD 10.00 a receipt.', field: 'total' }]);
    set({ categoryLimits: { Meals: 10.9 } });
    expect(pcodes(mine())).toEqual([]);                                             // at the limit is within it
    // a foreign receipt is held to what it comes to in SGD, not its own figure
    const inr = mine({ currency: 'INR', total: 1000, tax: null, aiRead: null, lines: [{ category: 'Meals', amount: 1000, baseAmount: 16.41 }] });
    set({ categoryLimits: { Meals: 20 } });
    expect(pcodes(inr)).toEqual([]);
    set({ categoryLimits: { Meals: 16 } });
    expect(pcodes(inr)).toEqual(['over-limit']);
    // a line with no category is the receipt's; one not priced yet has its own red flag
    expect(pcodes(mine({ lines: [{ amount: 10.9, baseAmount: 10.9 }] }))).toEqual([]);
    expect(pcodes(mine({ category: 'Meals', total: 30, tax: null, aiRead: null, lines: [{ amount: 30, baseAmount: 30 }] }))).toEqual(['over-limit']);
    expect(pcodes(mine({ currency: 'INR', total: 5000, tax: null, aiRead: null, fxPending: true, lines: [{ category: 'Meals', amount: 5000, baseAmount: null }] }))).toEqual(['no-rate']);
    // a category with no limit is not limited
    expect(pcodes(mine({ category: 'Phone', total: 900, tax: null, aiRead: null, lines: [{ category: 'Phone', amount: 900, baseAmount: 900 }] }))).toEqual([]);
  });

  test('a receipt in several categories: each part to its own limit, said together', () => {
    set({ categoryLimits: { Meals: 50, Lodging: 500 } });
    expect(flags.flagsFor(folio(480, 100), null, opts)).toEqual([{ code: 'over-limit', level: 'yellow', text: 'Over the limit a receipt: Meals SGD 100.00 (limit 50.00).', field: 'lines' }]);
    expect(flags.flagsFor(folio(520, 60), null, opts)[0].text).toBe('Over the limit a receipt: Lodging SGD 520.00 (limit 500.00); Meals SGD 60.00 (limit 50.00).');
    expect(pcodes(folio(500, 50))).toEqual([]);
  });

  test('too old: further back than the maximum age on the day it is shown', () => {
    set({ maxAgeDays: 30 });
    // 21 October less 30 days is 21 September
    expect(pcodes(mine({ receiptDate: '2026-09-21' }))).toEqual([]);
    expect(flags.flagsFor(mine({ receiptDate: '2026-09-20' }), null, opts)).toEqual([{ code: 'too-old', level: 'yellow', text: 'It is more than 30 days old; the company\'s policy is 30 days.', field: 'receiptDate' }]);
    expect(pcodes(mine({ receiptDate: '2026-09-20' }), null, { baseCurrency: 'SGD' })).toEqual([]);   // no day given, nothing to compare
    set({ maxAgeDays: 1 });
    expect(flags.flagsFor(mine({ receiptDate: '2026-10-19' }), null, opts)[0].text).toBe('It is more than 1 day old; the company\'s policy is 1 day.');
  });

  test('a weekend, when the company asks', () => {
    expect(pcodes(mine({ receiptDate: '2026-09-05' }))).toEqual([]);
    set({ flagWeekends: true });
    expect(flags.flagsFor(mine({ receiptDate: '2026-09-05' }), null, opts)).toEqual([{ code: 'weekend', level: 'yellow', text: 'It is dated on a Saturday.', field: 'receiptDate' }]);
    expect(flags.flagsFor(mine({ receiptDate: '2026-09-06' }), null, opts)[0].text).toBe('It is dated on a Sunday.');
    expect(pcodes(mine({ receiptDate: '2026-09-04' }))).toEqual([]);                // a Friday
  });

  test('a meal on a day the case\'s per diem pays for', () => {
    const trip = { periodFrom: '2026-09-01', periodTo: '2026-09-04', expenses: [{ id: 'pd', source: 'per_diem' }] };
    expect(flags.flagsFor(mine({ receiptDate: '2026-09-02' }), trip, opts)).toEqual([{ code: 'per-diem-meal', level: 'yellow', text: 'The case\'s per diem already pays for meals on this day.', field: 'category' }]);
    expect(pcodes(mine({ receiptDate: '2026-09-01' }), trip)).toEqual(['per-diem-meal']);
    expect(pcodes(mine({ receiptDate: '2026-09-05' }), trip)).toEqual(['outside-case']);
    expect(pcodes(folio(100, 30), trip)).toEqual(['per-diem-meal']);                 // a dinner on the hotel bill is a meal too
    expect(pcodes(mine({ category: 'Air & Transport', lines: [{ category: 'Air & Transport', amount: 10.9, baseAmount: 10.9 }] }), trip)).toEqual([]);
    expect(pcodes(mine(), { ...trip, expenses: [] })).toEqual([]);                   // no per diem, nothing to overlap
    expect(pcodes(mine({ id: 'pd', source: 'per_diem' }), trip)).toEqual([]);        // never on the per diem itself
    expect(pcodes(mine(), { ...trip, periodTo: null })).toEqual([]);
  });

  test('a list that has only the case\'s dates asks the database whether it holds a per diem', () => {
    const store = require('../store/expenses');
    const reports = require('../store/reports');
    const owner = require('../db').prepare('SELECT id FROM users LIMIT 1').get().id;
    const r = reports.createReport({ companyId, userId: owner, kind: 'trip', periodFrom: '2026-09-01', periodTo: '2026-09-04' });
    const meal = store.createExpense({ companyId, userId: owner, reportId: r.id, status: 'reviewed', merchant: 'Toast Box', category: 'Meals', currency: 'SGD', total: 10.9, receiptDate: '2026-09-02',
      lines: [{ category: 'Meals', amount: 10.9, baseAmount: 10.9 }] });
    const dates = { periodFrom: '2026-09-01', periodTo: '2026-09-04' };
    expect(pcodes(meal, dates)).toEqual([]);
    store.createExpense({ companyId, userId: owner, reportId: r.id, source: 'per_diem', status: 'reviewed', merchant: 'Per diem', category: 'Meals', currency: 'SGD', total: 200, receiptDate: '2026-09-01',
      lines: [{ category: 'Meals', amount: 200, baseAmount: 200 }] });
    expect(pcodes(meal, dates)).toEqual(['per-diem-meal']);
  });

  test('a per diem and a mileage claim carry none of the reader\'s flags; a per diem no limit or weekend either', () => {
    set({ categoryLimits: { Meals: 10, 'Fuel/Mileage': 10 }, flagWeekends: true, maxAgeDays: 30 });
    const note = require('./read-receipt').currencyNote('INR');
    const pd = mine({ source: 'per_diem', receiptId: null, merchant: 'Per diem', currency: 'INR', total: 14000, tax: 9, receiptDate: '2026-09-05', errorMsg: note, aiRead: { total: 1 },
      lines: [{ category: 'Meals', amount: 14000, baseAmount: 229.74 }] });
    expect(pcodes(pd)).toEqual(['too-old']);
    const km = mine({ source: 'mileage', receiptId: null, merchant: 'Mileage', category: 'Fuel/Mileage', currency: 'SGD', total: 107, tax: 7, receiptDate: '2026-09-05', errorMsg: null, aiRead: { total: 1 },
      lines: [{ category: 'Fuel/Mileage', amount: 107, baseAmount: 107 }] });
    expect(pcodes(km)).toEqual(['over-limit', 'too-old', 'weekend']);
    // the same as a receipt says all of it
    expect(pcodes({ ...km, source: 'upload' })).toEqual(['gst-mismatch', 'edited-amount', 'over-limit', 'too-old', 'weekend']);
  });
});
