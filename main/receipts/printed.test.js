const P = require('./printed');

// A row as the record holds it, with only what differs said.
const row = (kind, label, amount, x = {}) => ({ kind, label, amount, qty: null, unitPrice: null, rate: null, included: false, worked: false,
  category: null, onBehalfOf: null, taxRate: null, on: null, ...x });
const rec = (rows, total, subtotal = null) => P.validate({ v: 1, rows, subtotal, total });
const shown = lines => lines.map(l => [l.category, l.onBehalfOf, l.amount]);
const sum = lines => Math.round(lines.reduce((s, l) => s + l.amount * 100, 0)) / 100;

// The Kuala Lumpur nasi kandar bill: three items, a 10% service charge, SST
// of 6% on the food and the service charge, and 5-sen rounding.
const nasiKandar = () => rec([
  row('item', 'Nasi Kandar Ayam Goreng', 14.5, { qty: 1, category: 'Meals' }),
  row('item', 'Roti Canai', 3, { qty: 2, unitPrice: 1.5, category: 'Meals' }),
  row('item', 'Teh Tarik', 6.4, { qty: 2, unitPrice: 3.2, category: 'Meals', onBehalfOf: 'Jane Tan' }),
  row('charge', 'Service Charge', 2.39, { rate: 10 }),
  row('tax', 'SST', 1.58, { rate: 6 }),
  row('rounding', 'Rounding Adj', -0.02),
], 27.85, 23.9);

// A Kuala Lumpur hotel: the room with its service charge, Service Tax 8% and
// a tourism tax of RM10, and dinner with its service charge and SST 6%.
const twoRateHotel = () => rec([
  row('item', 'Room Charge', 280, { category: 'Lodging' }),
  row('charge', 'Service Charge', 28, { rate: 10, on: 0 }),
  row('tax', 'Service Tax', 24.64, { rate: 8, on: 0 }),
  row('charge', 'Tourism Tax', 10, { on: 0 }),
  row('item', 'Lounge Dinner', 85, { category: 'Meals' }),
  row('charge', 'Service Charge', 8.5, { rate: 10, on: 4 }),
  row('tax', 'SST', 5.61, { rate: 6, on: 4 }),
], 441.75);

describe('receipts/printed — a record is checked before it is kept', () => {
  test('a clean record comes back in its shape, extra keys gone', () => {
    const r = P.validate({ rows: [{ kind: 'Item', label: '  Teh   tarik ', amount: '5.60', qty: 2, unitPrice: 2.8, category: 'meals', colour: 'red' }], total: 5.6 });
    expect(r).toEqual({ v: 1, subtotal: null, total: 5.6, rows: [row('item', 'Teh tarik', 5.6, { qty: 2, unitPrice: 2.8, category: 'Meals' })] });
  });

  test('a discount takes off however it is typed, and a row with no name is called what it is', () => {
    const r = P.validate({ rows: [row('item', 'A4', 13.8), row('discount', '', 3.45, { rate: 50, on: 0 })], total: 10.35 });
    expect(r.rows[1]).toMatchObject({ kind: 'discount', label: 'Discount', amount: -3.45, rate: 50, on: 0 });
  });

  test('fields that mean nothing on a kind are dropped: a rate on an item, a tax rate on a charge, included on a charge', () => {
    const r = P.validate({ rows: [row('item', 'Room', 100, { rate: 8, included: true, on: 1 }), row('charge', 'SC', 10, { taxRate: 6, included: true, qty: 3 }),
                                 row('rounding', 'Rounding', 0.02, { category: 'Meals', on: 0, onBehalfOf: 'X' })], total: 110.02 });
    expect(r.rows[0]).toMatchObject({ rate: null, included: false, on: null });
    expect(r.rows[1]).toMatchObject({ taxRate: null, included: false, qty: null });
    expect(r.rows[2]).toMatchObject({ category: null, on: null, onBehalfOf: null });
  });

  test.each([
    [null, /rows and its total/],
    [{ total: 10 }, /rows, as a list/],
    [{ rows: [], total: 'ten' }, /The total must be a number/],
    [{ rows: [], total: -1 }, /The total must be a number from 0 up/],
    [{ rows: [], total: 10, subtotal: -5 }, /subtotal must be a number from 0 up/],
    [{ v: 2, rows: [], total: 10 }, /version/],
    [{ rows: ['x'], total: 10 }, /Row 1 is not a row/],
    [{ rows: [row('fee', 'Fee', 1)], total: 10 }, /Row 1 must be an item, a charge, a discount, a tax or a rounding/],
    [{ rows: [row('item', 'x'.repeat(121), 1)], total: 10 }, /longer than 120/],
    [{ rows: [row('item', 'Room', 'abc')], total: 10 }, /Row 1 \(Room\): the amount must be a number/],
    [{ rows: [row('item', 'Room', null)], total: 10 }, /the amount is missing/],
    [{ rows: [row('charge', 'SC', -2)], total: 10 }, /cannot be below zero/],
    [{ rows: [row('tax', 'SST', 1, { rate: 160 })], total: 10 }, /percentage from 0 to 100/],
    [{ rows: [row('item', 'Room', 1, { category: 'Snacks' })], total: 10 }, /unknown category "Snacks"/],
    [{ rows: [row('tax', 'SST', 1, { on: 4 })], total: 10 }, /sits under a row that is not there/],
    [{ rows: [row('tax', 'SST', 1, { on: 0 })], total: 10 }, /cannot sit under itself/],
    [{ rows: [row('item', 'Room', 9), row('tax', 'SST', 1, { on: 0 }), row('tax', 'X', 1, { on: 1 })], total: 11 }, /which is a tax/],
    [{ rows: [row('charge', 'A', 1, { on: 1 }), row('discount', 'B', 1, { on: 0 })], total: 10 }, /sit under each other/],
  ])('refused with a sentence: %j', (input, message) => {
    expect(() => P.validate(input)).toThrow(message);
    try { P.validate(input); } catch (err) { expect(err.status).toBe(400); }
  });

  test('at most 300 rows', () => {
    const rows = Array.from({ length: 301 }, (_, i) => row('item', `Item ${i}`, 1));
    expect(() => P.validate({ rows, total: 301 })).toThrow(/at most 300 rows/);
    expect(() => P.validate({ rows: rows.slice(0, 300), total: 300 })).not.toThrow();
  });
});

describe('receipts/printed — the currency\'s step, and whether the rows add up', () => {
  test('5 sen in ringgit and Singapore dollars, a unit in rupees and yen, 10 won, 100 rupiah, 1,000 dong, else 2 cents', () => {
    expect([P.step('MYR'), P.step('sgd'), P.step('INR'), P.step('JPY'), P.step('KRW'), P.step('IDR'), P.step('VND'), P.step('EUR'), P.step(null)])
      .toEqual([0.05, 0.05, 1, 1, 10, 100, 1000, 0.02, 0.02]);
  });

  test('the nasi kandar bill adds up to the cent; 0.30 short is said as 0.30 under', () => {
    expect(P.addsUp(nasiKandar(), 'MYR')).toEqual({ ok: true, sum: 27.85, gap: 0 });
    const short = rec(nasiKandar().rows.filter(r => r.label !== 'Teh Tarik'), 27.85);
    expect(P.addsUp(short, 'MYR')).toEqual({ ok: false, sum: 21.45, gap: 6.4 });
  });

  test('within the step without a rounding row, within a cent with one', () => {
    const bill = extra => rec([row('item', 'Lunch', 10), ...extra], 10.05);
    expect(P.addsUp(bill([]), 'MYR').ok).toBe(true);           // 5 sen off, nobody printed the rounding
    expect(P.addsUp(bill([]), 'EUR').ok).toBe(false);          // 5 cents is not a euro step
    expect(P.addsUp(bill([row('rounding', 'Rounding', 0.03)]), 'MYR').ok).toBe(false);   // a rounding row leaves nothing to round
    expect(P.addsUp(bill([row('rounding', 'Rounding', 0.05)]), 'MYR').ok).toBe(true);
  });

  test('an included tax is not added; taxes printed per charge carry half a percent', () => {
    expect(P.addsUp(rec([row('item', 'Rice', 13.8), row('tax', 'GST', 1.14, { rate: 9, included: true })], 13.8), 'SGD').ok).toBe(true);
    const folio = rec([row('item', 'Room', 10000), row('tax', 'CGST', 900, { rate: 9, on: 0 }), row('tax', 'SGST', 900, { rate: 9, on: 0 })], 11830);
    expect(P.addsUp(folio, 'INR')).toEqual({ ok: true, sum: 11800, gap: 30 });
  });
});

describe('receipts/printed — the tax figure', () => {
  test('the tax rows, added and included; none printed is no tax', () => {
    expect(P.taxOf(nasiKandar())).toBe(1.58);
    expect(P.taxOf(twoRateHotel())).toBe(30.25);
    expect(P.taxOf(rec([row('item', 'Rice', 13.8)], 13.8))).toBeNull();
  });
  test('a tax summary printed on the receipt wins, unless it is more than the total', () => {
    const jw = rec([row('item', 'Room', 37550), row('tax', 'CGST', 3380, { rate: 9, on: 0 }), row('tax', 'SGST', 3380, { rate: 9, on: 0 })], 44309);
    expect(P.taxOf(jw)).toBe(6760);
    expect(P.taxOf(jw, { summary: 6759 })).toBe(6759);
    expect(P.taxOf(jw, { summary: 50000 })).toBe(6760);
  });
  test('a record whose tax rows are unchanged keeps the tax it had', () => {
    const was = nasiKandar();
    const now = { ...was, rows: was.rows.map(r => (r.label === 'Teh Tarik' ? { ...r, amount: 6.5 } : r)) };
    expect(P.taxOf(now, { was, tax: 1.6 })).toBe(1.6);
    const retaxed = { ...was, rows: was.rows.map(r => (r.kind === 'tax' ? { ...r, amount: 1.6 } : r)) };
    expect(P.taxOf(retaxed, { was, tax: 1.58 })).toBe(1.6);
  });
});

describe('receipts/printed — claim lines from the record', () => {
  test('the nasi kandar bill: one line per person, the service charge and SST spread by amount, the rounding on the claimant\'s own', () => {
    const lines = P.claimLines(nasiKandar(), 'Meals');
    expect(sum(lines)).toBe(27.85);
    expect(shown(lines)).toEqual([['Meals', null, 20.39], ['Meals', 'Jane Tan', 7.46]]);
    expect(lines[0].description).toBe('Nasi Kandar Ayam Goreng +1 more');
    // SST of 1.58 at 6% is on the food and the service charge (26.29), and
    // its two shares come to what was printed.
    const sst = lines.map(l => l.taxes.find(t => t.label === 'SST'));
    expect(sst.map(t => t.amount).reduce((a, b) => a + b, 0)).toBeCloseTo(1.58, 10);
    expect(sst[0]).toEqual({ label: 'SST', rate: 6, amount: 1.16, included: false, gross: 20.41, basis: '0,1,3' });
    expect(sst[1]).toEqual({ label: 'SST', rate: 6, amount: 0.42, included: false, gross: 7.46, basis: '2,3' });
  });

  test('the two-rate KL hotel: Lodging with Service Tax 8% and Meals with SST 6%, exactly as printed', () => {
    const lines = P.claimLines(twoRateHotel(), 'Lodging');
    expect(lines).toEqual([
      { category: 'Lodging', description: 'Room Charge', amount: 342.64, onBehalfOf: null,
        taxes: [{ label: 'Service Tax', rate: 8, amount: 24.64, included: false, gross: 332.64, basis: '0,1' }] },
      { category: 'Meals', description: 'Lounge Dinner', amount: 99.11, onBehalfOf: null,
        taxes: [{ label: 'SST', rate: 6, amount: 5.61, included: false, gross: 99.11, basis: '4,5' }] },
    ]);
  });

  test('the same hotel printed with a tax summary: each tax finds its items by their tax rate', () => {
    const lines = P.claimLines(rec([
      row('item', 'Room Charge', 280, { category: 'Lodging', taxRate: 8 }),
      row('item', 'Lounge Dinner', 85, { category: 'Meals', taxRate: 6 }),
      row('charge', 'Service Charge', 36.5, { rate: 10 }),
      row('charge', 'Tourism Tax', 10, { category: 'Lodging' }),
      row('tax', 'Service Tax', 24.64, { rate: 8 }),
      row('tax', 'Service Tax', 5.61, { rate: 6 }),
    ], 441.75), 'Lodging');
    expect(shown(lines)).toEqual([['Lodging', null, 342.64], ['Meals', null, 99.11]]);
    expect(lines.map(l => l.taxes)).toEqual([[{ label: 'Service Tax', rate: 8, amount: 24.64, included: false, gross: 332.64, basis: '0,2' }],
                                              [{ label: 'Service Tax', rate: 6, amount: 5.61, included: false, gross: 99.11, basis: '1,2' }]]);
  });

  test('a folio with CGST and SGST under each charge and a colleague\'s room transferred onto it', () => {
    const lines = P.claimLines(rec([
      row('item', 'Room Charge', 10000, { category: 'Lodging' }),
      row('tax', 'CGST', 900, { rate: 9, on: 0 }), row('tax', 'SGST', 900, { rate: 9, on: 0 }),
      row('item', 'Room Charge', 10000, { category: 'Lodging', onBehalfOf: 'Lim Wei Jie' }),
      row('tax', 'CGST', 900, { rate: 9, on: 3 }), row('tax', 'SGST', 900, { rate: 9, on: 3 }),
      row('item', 'MoMo Cafe Dinner', 1200, { category: 'Meals', onBehalfOf: 'Lim Wei Jie' }),
      row('tax', 'CGST', 30, { rate: 2.5, on: 6 }), row('tax', 'SGST', 30, { rate: 2.5, on: 6 }),
      row('item', 'MoMo Cafe Dinner', 1296.25, { category: 'Meals' }),
      row('tax', 'CGST', 32.41, { rate: 2.5, on: 9 }), row('tax', 'SGST', 32.41, { rate: 2.5, on: 9 }),
    ], 26221.07), 'Lodging');
    expect(shown(lines)).toEqual([['Lodging', null, 11800], ['Lodging', 'Lim Wei Jie', 11800], ['Meals', null, 1361.07], ['Meals', 'Lim Wei Jie', 1260]]);
    // The pair on one charge shares one gross: what Xero takes at 18% (or 5%).
    expect(lines[1].taxes).toEqual([{ label: 'CGST', rate: 9, amount: 900, included: false, gross: 11800, basis: '3' }, { label: 'SGST', rate: 9, amount: 900, included: false, gross: 11800, basis: '3' }]);
    expect(lines[3].taxes).toEqual([{ label: 'CGST', rate: 2.5, amount: 30, included: false, gross: 1260, basis: '6' }, { label: 'SGST', rate: 2.5, amount: 30, included: false, gross: 1260, basis: '6' }]);
  });

  test('a pair printed together for the whole bill finds items at its combined rate', () => {
    const lines = P.claimLines(rec([
      row('item', 'Room', 1000, { category: 'Lodging', taxRate: 18 }),
      row('item', 'Breakfast', 100, { category: 'Meals', taxRate: 5 }),
      row('tax', 'CGST', 90, { rate: 9 }), row('tax', 'SGST', 90, { rate: 9 }),
      row('tax', 'CGST', 2.5, { rate: 2.5 }), row('tax', 'SGST', 2.5, { rate: 2.5 }),
    ], 1285), 'Lodging');
    expect(lines.map(l => [l.category, l.amount, l.taxes.map(t => `${t.label} ${t.rate} ${t.amount} ${t.gross}`)])).toEqual([
      ['Lodging', 1180, ['CGST 9 90 1180', 'SGST 9 90 1180']],
      ['Meals', 105, ['CGST 2.5 2.5 105', 'SGST 2.5 2.5 105']],
    ]);
  });

  test('an included GST is recorded on the line and not added to it', () => {
    const lines = P.claimLines(rec([
      row('item', 'Steamed Chicken Rice', 11, { qty: 2, unitPrice: 5.5 }), row('item', 'Barley (Hot)', 1.8), row('item', 'Braised Egg', 1),
      row('tax', 'GST', 1.14, { rate: 9, included: true }),
    ], 13.8, 13.8), 'Meals');
    expect(lines).toEqual([{ category: 'Meals', description: 'Steamed Chicken Rice +2 more', amount: 13.8, onBehalfOf: null,
                             taxes: [{ label: 'GST', rate: 9, amount: 1.14, included: true, gross: 13.8, basis: '0,1,2' }] }]);
  });

  test('a discount printed under an item comes off that item, and the included GST is shared by what each line holds', () => {
    const lines = P.claimLines(rec([
      row('item', 'Fresh Milk 2L', 6.95, { category: 'Meals' }),
      row('item', 'A4 Paper 500 Shts', 13.8, { qty: 2, unitPrice: 6.9, category: 'Office Supplies' }),
      row('discount', '2nd Unit 50% Off', -3.45, { rate: 50, on: 1 }),
      row('item', 'Ballpoint Pen 10pk', 5.6, { category: 'Office Supplies' }),
      row('tax', 'GST', 1.89, { rate: 9, included: true }),
    ], 22.9, 22.9), 'Other');
    expect(shown(lines)).toEqual([['Office Supplies', null, 15.95], ['Meals', null, 6.95]]);
    expect(lines.map(l => l.taxes[0].amount)).toEqual([1.32, 0.57]);
    expect(lines.map(l => l.taxes[0].gross)).toEqual([15.95, 6.95]);
  });

  test('a tax is charged on what its rate bears out: a Berlin hotel\'s VAT is on the rooms without the city tax', () => {
    const lines = P.claimLines(rec([
      row('item', 'Logis', 180, { category: 'Lodging', taxRate: 7 }), row('item', 'Logis', 180, { category: 'Lodging', taxRate: 7 }),
      row('item', 'Fruehstueck', 24, { category: 'Meals', taxRate: 19 }),
      row('charge', 'City Tax', 18, { rate: 5, category: 'Lodging' }),
      row('tax', 'MwSt', 23.55, { rate: 7, included: true }), row('tax', 'MwSt', 3.83, { rate: 19, included: true }),
    ], 402), 'Lodging');
    // The city tax is the rooms' (it names Lodging), and not under the VAT.
    expect(lines).toEqual([
      { category: 'Lodging', description: 'Logis +1 more', amount: 378, onBehalfOf: null, taxes: [{ label: 'MwSt', rate: 7, amount: 23.55, included: true, gross: 360, basis: '0,1' }] },
      { category: 'Meals', description: 'Fruehstueck', amount: 24, onBehalfOf: null, taxes: [{ label: 'MwSt', rate: 19, amount: 3.83, included: true, gross: 24, basis: '2' }] },
    ]);
  });

  test('a tip is in the amount and not under the sales tax', () => {
    const lines = P.claimLines(rec([
      row('item', 'Ribeye Steak', 42), row('item', 'Grilled Salmon', 34), row('item', 'Iced Tea', 9, { qty: 2, unitPrice: 4.5 }), row('item', 'Caesar Salad', 14),
      row('tax', 'Sales Tax', 8.54, { rate: 8.625 }), row('charge', 'SF Mandate', 3.96, { rate: 4 }), row('charge', 'Tip', 20),
    ], 131.5, 99), 'Meals');
    expect(lines).toEqual([{ category: 'Meals', description: 'Ribeye Steak +3 more', amount: 131.5, onBehalfOf: null,
                             taxes: [{ label: 'Sales Tax', rate: 8.625, amount: 8.54, included: false, gross: 107.54, basis: '0,1,2,3' }] }]);
  });

  test('rows a little short of the total: the difference is the claimant\'s, in the receipt\'s category', () => {
    const lines = P.claimLines(rec([row('item', 'Room', 300, { category: 'Lodging', onBehalfOf: 'Lim Wei Jie' }), row('item', 'Dinner', 50, { category: 'Meals' })], 400), 'Lodging');
    expect(shown(lines)).toEqual([['Lodging', 'Lim Wei Jie', 300], ['Meals', null, 50], ['Lodging', null, 50]]);
  });

  test('rows nowhere near the total give one line of the whole total, with the taxes still on it', () => {
    const lines = P.claimLines(rec([row('item', 'Latte', 5.5), row('tax', 'GST', 0.45, { rate: 9, included: true })], 40), 'Meals', { description: '[Meals] Coffee @ Joe' });
    expect(lines).toEqual([{ category: 'Meals', description: '[Meals] Coffee @ Joe', amount: 40, onBehalfOf: null,
                             taxes: [{ label: 'GST', rate: 9, amount: 0.45, included: true, gross: 5.5, basis: '0' }] }]);
  });

  test('a receipt that itemises nothing still has its tax on its one line', () => {
    const lines = P.claimLines(rec([row('tax', 'GST', 0.83, { rate: 9, included: true })], 10), 'Meals', { description: 'Lunch' });
    expect(lines).toEqual([{ category: 'Meals', description: 'Lunch', amount: 10, onBehalfOf: null, taxes: [{ label: 'GST', rate: 9, amount: 0.83, included: true, gross: 10, basis: 'receipt' }] }]);
  });

  test('no tax printed is an empty list, not unknown; no total is no lines', () => {
    expect(P.claimLines(rec([row('item', 'Fare', 19.5), row('discount', 'Promo', -2)], 17.5), 'Air & Transport')[0].taxes).toEqual([]);
    expect(P.claimLines(rec([row('item', 'Fare', 19.5)], 0), 'Other')).toEqual([]);
    expect(P.claimLines(null, 'Other')).toEqual([]);
  });

  test('a discount larger than its line leaves nothing negative: the line folds into the claimant\'s own', () => {
    const lines = P.claimLines(rec([
      row('item', 'Coffee', 5, { category: 'Meals', onBehalfOf: 'Ali' }), row('discount', 'Voucher', -8, { on: 0 }), row('item', 'Room', 100, { category: 'Lodging' }),
    ], 97), 'Lodging');
    expect(shown(lines)).toEqual([['Lodging', null, 97]]);
  });
});

// What each tax was charged on (line.taxes[].basis), so Xero can put CGST and
// SGST on the same charges on one line at 18%, and keep apart two taxes that
// share nothing.
describe('receipts/printed — what each tax was charged on', () => {
  test('two nights, each with its own GST inside the price: one GST on the line, charged on both nights', () => {
    const lines = P.claimLines(rec([
      row('item', '12/10 Room Charge', 200, { category: 'Lodging' }), row('tax', 'GST', 16.51, { rate: 9, included: true, on: 0 }),
      row('item', '13/10 Room Charge', 200, { category: 'Lodging' }), row('tax', 'GST', 16.51, { rate: 9, included: true, on: 2 }),
    ], 400), 'Lodging');
    expect(lines).toEqual([{ category: 'Lodging', description: '12/10 Room Charge +1 more', amount: 400, onBehalfOf: null,
                             taxes: [{ label: 'GST', rate: 9, amount: 33.02, included: true, gross: 400, basis: '0,2' }] }]);
  });

  test('two nights with CGST and SGST under each: the pair shares one basis, both nights', () => {
    const [line] = P.claimLines(rec([
      row('item', 'Room 01/09', 10000, { category: 'Lodging' }), row('tax', 'CGST', 900, { rate: 9, on: 0 }), row('tax', 'SGST', 900, { rate: 9, on: 0 }),
      row('item', 'Room 02/09', 10000, { category: 'Lodging' }), row('tax', 'CGST', 900, { rate: 9, on: 3 }), row('tax', 'SGST', 900, { rate: 9, on: 3 }),
    ], 23600), 'Lodging');
    expect(line.taxes).toEqual([{ label: 'CGST', rate: 9, amount: 1800, included: false, gross: 23600, basis: '0,3' },
                                { label: 'SGST', rate: 9, amount: 1800, included: false, gross: 23600, basis: '0,3' }]);
  });

  test('a 6% and an 8% on one line that share nothing keep apart', () => {
    const [line] = P.claimLines(rec([
      row('item', 'Room', 280, { category: 'Lodging', taxRate: 8 }), row('item', 'Laundry', 50, { category: 'Lodging', taxRate: 6 }),
      row('tax', 'Service Tax', 22.4, { rate: 8 }), row('tax', 'SST', 3, { rate: 6 }),
    ], 355.4), 'Lodging');
    expect(line.taxes.map(t => [t.label, t.rate, t.amount, t.gross, t.basis])).toEqual([['Service Tax', 8, 22.4, 302.4, '0'], ['SST', 6, 3, 53, '1']]);
  });

  test('a service charge the rate bears out is in the basis; a flat levy is not', () => {
    const [line] = P.claimLines(rec([
      row('item', 'Room Charge', 280, { category: 'Lodging' }), row('charge', 'Service Charge', 28, { rate: 10, on: 0 }),
      row('tax', 'Service Tax', 24.64, { rate: 8, on: 0 }), row('charge', 'Tourism Tax', 10, { on: 0 }),
    ], 342.64), 'Lodging');
    expect(line.taxes[0]).toMatchObject({ gross: 332.64, basis: '0,1' });
  });
});

describe('receipts/printed — India\'s split tax, and only it, is one tax at the sum of its halves', () => {
  const t = (label, rate, x = {}) => row('tax', label, 1, { rate, ...x });
  test('CGST with SGST, UTGST or IGST, either way round, at one rate', () => {
    expect([P.splitPair(t('CGST', 9), t('SGST', 9)), P.splitPair(t('SGST', 9), t('CGST', 9)), P.splitPair(t('cgst', 6), t('UTGST', 6)),
            P.splitPair(t('CGST', 9), t('IGST', 9)), P.splitPair(t(' CGST ROOM', 9), t('SGST ROOM', 9))]).toEqual([true, true, true, true, true]);
  });
  test('not two other taxes at one rate, not at two rates, not one inside the prices and one added', () => {
    expect([P.splitPair(t('Service Tax', 8), t('SST', 8)), P.splitPair(t('GST', 5), t('PST', 5)), P.splitPair(t('CGST', 9), t('CGST', 9)),
            P.splitPair(t('CGST', 9), t('SGST', 6)), P.splitPair(t('CGST', 9), t('SGST', 9, { included: true })), P.splitPair(t('JW Cafe CGST', 9), t('SGST', 9)),
            P.splitPair(t('CGST', null), t('SGST', null))]).toEqual([false, false, false, false, false, false, false]);
  });
  test('two other taxes printed together at 8% are each 8%, not one of 16%', () => {
    const lines = P.claimLines(rec([
      row('item', 'Room', 200, { category: 'Lodging', taxRate: 8 }), row('item', 'Mineral water', 10, { category: 'Meals', taxRate: 0 }),
      row('tax', 'Service Tax', 16, { rate: 8 }), row('tax', 'SST', 0, { rate: 8 }),
    ], 226), 'Lodging');
    expect(lines.map(l => [l.category, l.amount, l.taxes.map(x => `${x.label} ${x.amount}`)])).toEqual([['Lodging', 216, ['Service Tax 16', 'SST 0']], ['Meals', 10, []]]);
  });
});

describe('receipts/printed — a tax whose rate no item shows', () => {
  // The 6%/8% Kuala Lumpur bill after QA moved the valet parking from 8% to
  // 6% and added a colleague's tea marked "–": the SST 8% of 0.96 has no item
  // at its rate, and used to go wholly on the tea.
  const bill = () => rec([
    row('item', 'Nasi Lemak Special', 31.8, { category: 'Meals', taxRate: 6 }),
    row('item', 'Teh Tarik Ais', 9, { category: 'Meals', taxRate: 6 }),
    row('item', 'Valet Parking', 12, { category: 'Air & Transport', taxRate: 6 }),
    row('item', 'Teh Tarik', 3, { category: 'Meals', onBehalfOf: 'Jane Tan', taxRate: null }),
    row('tax', 'SST', 2.45, { rate: 6 }), row('tax', 'SST', 0.96, { rate: 8 }),
  ], 59.21);
  test('is spread over every item by amount, never onto an unmarked item only for being unmarked', () => {
    const lines = P.claimLines(bill(), 'Meals');
    const jane = lines.find(l => l.onBehalfOf === 'Jane Tan');
    expect(jane.taxes).toEqual([{ label: 'SST', rate: 8, amount: 0.05, included: false, gross: 3.05, basis: '3' }]);
    const eight = lines.flatMap(l => l.taxes.filter(t => t.rate === 8));
    expect(eight.reduce((s, t) => s + t.amount * 100, 0)).toBe(96);
    expect(lines.find(l => l.category === 'Air & Transport').taxes.map(t => t.rate)).toEqual([6, 8]);
  });
  test('and when every item shows another rate, over all of them', () => {
    const r = bill(); r.rows[3].taxRate = 6;
    const eight = P.claimLines(r, 'Meals').flatMap(l => l.taxes.filter(t => t.rate === 8));
    expect(eight.map(t => t.amount)).toEqual([0.7, 0.21, 0.05]);
  });
});

describe('receipts/printed — what changed, in words', () => {
  const before = [row('item', 'Teh tarik', 5.6, { category: 'Meals' }), row('item', 'Roti canai', 3, { category: 'Meals' }),
                  row('charge', 'Service charge', 0.86, { rate: 10 }), row('tax', 'SST', 0.57, { rate: 6 }), row('rounding', 'Rounding', -0.03)];
  test('each row said as a person would: an amount, a rate, a category, one added and one removed', () => {
    const after = [row('item', 'Teh tarik', 5.6, { category: 'Meals', onBehalfOf: 'Jane Tan' }), row('item', 'Roti canai', 3, { category: 'Other' }),
                   row('item', 'Nasi lemak', 7.5, { category: 'Meals' }), row('charge', 'Service charge', 0, { rate: 0 }), row('tax', 'SST', 0.6, { rate: 6 })];
    expect(P.rowChanges(before, after)).toEqual([
      'Teh tarik now for Jane Tan', 'Category of Roti canai Meals → Other', 'Added Nasi lemak 7.50',
      'Service charge 10% → 0%', 'Service charge 0% 0.86 → 0.00', 'SST 6% 0.57 → 0.60', 'Removed Rounding −0.03',
    ]);
  });
  test('a rename, a change of kind, and a row moved under another', () => {
    const after = [row('item', 'Teh tarik ais', 5.6, { category: 'Meals' }), row('item', 'Roti canai', 3, { category: 'Meals' }),
                   row('tax', 'Service charge', 0.86, { rate: 10 }), row('tax', 'SST', 0.57, { rate: 6, on: 1 }), row('rounding', 'Rounding', -0.03)];
    expect(P.rowChanges(before, after)).toEqual(['Renamed Teh tarik to Teh tarik ais', 'Service charge is now a tax', 'SST 6% now on Roti canai']);
  });
  test('for the log: five named and then how many more; a first record and one dropped', () => {
    const after = before.map(r => ({ ...r, amount: r.amount + (r.amount < 0 ? -0.01 : 0.01) })).concat([row('item', 'Kopi', 2)]);
    expect(P.describeChange({ rows: before }, { rows: after })).toBe('Teh tarik 5.60 → 5.61 · Roti canai 3.00 → 3.01 · Service charge 10% 0.86 → 0.87 · SST 6% 0.57 → 0.58 · Rounding −0.03 → −0.04 · and 1 more');
    expect(P.describeChange(null, { rows: before })).toBe('Kept as printed: 2 items · Service charge 10% 0.86 · SST 6% 0.57 · Rounding −0.03');
    expect(P.describeChange({ rows: before }, null)).toBe('No longer kept as printed');
    expect(P.describeChange({ rows: before }, { rows: before.map(r => ({ ...r })) })).toBeNull();
    expect(P.describeChange(null, null)).toBeNull();
  });
});
