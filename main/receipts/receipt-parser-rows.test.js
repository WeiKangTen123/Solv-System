const { normalise, SYSTEM_PROMPT } = require('./receipt-parser');
const { claimLines } = require('./printed');

// The reader's rows (receipts/printed.js): every row the receipt prints, with
// its kind, name, rate and amount, as the model gives them and as the
// normaliser makes them safe. A row is written the way the model returns one.
const row = (kind, label, amount, x = {}) => ({ kind, label, amount, ...x });
const shown = r => r.rows.map(x => [x.kind, x.label, x.amount, x.rate, x.included, x.on]);

describe('the reader is asked for rows', () => {
  test('the prompt asks for each row\'s kind, name without its rate, rate, inclusion, tax rate and the row it is under', () => {
    for (const field of ['"kind"', '"label"', '"qty"', '"unitPrice"', '"amount"', '"rate"', '"included"', '"category"', '"onBehalfOf"', '"taxRate"', '"on"']) {
      expect(SYSTEM_PROMPT).toContain(field);
    }
    expect(SYSTEM_PROMPT).toMatch(/WITHOUT its rate or amount/);
    expect(SYSTEM_PROMPT).toMatch(/- taxTotal:/);
    expect(SYSTEM_PROMPT).toMatch(/- subTotal: the subtotal exactly as printed/);
    expect(SYSTEM_PROMPT).toMatch(/never a tax summary that repeats taxes already listed/);
  });
});

describe('the Kuala Lumpur nasi kandar bill, read as printed', () => {
  const r = normalise({ total: 27.85, subTotal: 23.9, currency: 'MYR', country: 'MY', category: 'Meals', rows: [
    row('item', 'Nasi Kandar Ayam Goreng', 14.5, { qty: 1, category: 'Meals' }),
    row('item', 'Roti Canai', 3, { qty: 2, unitPrice: 1.5, category: 'Meals' }),
    row('item', 'Teh Tarik', 6.4, { qty: 2, unitPrice: 3.2, category: 'Meals' }),
    row('tax', 'Service Charge 10%', 2.39, { rate: 10 }),
    row('tax', 'SST 6%', 1.58, { rate: 6 }),
    row('charge', 'Rounding Adj', -0.02),
  ] });
  test('every row is kept in order, with quantity and unit price; a service charge is never tax, a rounding is a rounding', () => {
    expect(shown(r)).toEqual([
      ['item', 'Nasi Kandar Ayam Goreng', 14.5, null, false, null], ['item', 'Roti Canai', 3, null, false, null], ['item', 'Teh Tarik', 6.4, null, false, null],
      ['charge', 'Service Charge', 2.39, 10, false, null], ['tax', 'SST', 1.58, 6, false, null], ['rounding', 'Rounding Adj', -0.02, null, false, null],
    ]);
    expect(r.rows[1]).toMatchObject({ qty: 2, unitPrice: 1.5 });
    expect(r).toMatchObject({ total: 27.85, tax: 1.58, subTotal: 23.9 });
  });
  test('its lines come from those rows to the cent', () => {
    expect(claimLines({ rows: r.rows, total: r.total }, 'Meals')).toEqual([{ category: 'Meals', description: 'Nasi Kandar Ayam Goreng +2 more', amount: 27.85, onBehalfOf: null,
      taxes: [{ label: 'SST', rate: 6, amount: 1.58, included: false, gross: 27.87, basis: '0,1,2,3' }] }]);
  });
});

describe('a folio with two rates and a tax summary', () => {
  // Hotel Seri Bukit, Kuala Lumpur: each night's service charge, Service Tax
  // 8% and tourism tax under the room; the dinner's service charge and SST 6%
  // under the dinner; then a tax summary that repeats both taxes and totals them.
  const rows = [
    row('item', '20/10 Room Charge', 280, { category: 'Lodging', taxRate: 8 }),
    row('charge', '20/10 Service Charge 10%', 28, { rate: 10, category: 'Lodging' }),
    row('tax', '20/10 Service Tax 8%', 24.64, { rate: 8 }),
    row('charge', '20/10 Tourism Tax', 10, { category: 'Lodging' }),
    row('item', '20/10 Lounge Dinner', 85, { category: 'Meals', taxRate: 6 }),
    row('charge', '20/10 Service Charge 10%', 8.5, { rate: 10, category: 'Meals' }),
    row('tax', '20/10 SST 6% (F&B)', 5.61, { rate: 6 }),
    row('tax', 'Service Tax 8% on 308.00', 24.64, { rate: 8 }),
    row('tax', 'SST 6% on 93.50', 5.61, { rate: 6 }),
    row('tax', 'Total Tax', 30.25),
  ];
  test('the summary\'s repeats go, its total is the tax, and each night\'s charges sit under the night', () => {
    const r = normalise({ total: 441.75, currency: 'MYR', country: 'MY', category: 'Lodging', docType: 'hotel', rows });
    expect(shown(r)).toEqual([
      ['item', '20/10 Room Charge', 280, null, false, null], ['charge', '20/10 Service Charge', 28, 10, false, 0], ['tax', 'Service Tax', 24.64, 8, false, 0],
      ['charge', '20/10 Tourism Tax', 10, null, false, null], ['item', '20/10 Lounge Dinner', 85, null, false, null],
      ['charge', '20/10 Service Charge', 8.5, 10, false, 4], ['tax', 'SST', 5.61, 6, false, 4],
    ]);
    expect(r.tax).toBe(30.25);
    expect(claimLines({ rows: r.rows, total: r.total }, 'Lodging').map(l => [l.category, l.amount, l.taxes.map(t => `${t.label} ${t.rate}% ${t.amount} on ${t.gross}`)])).toEqual([
      ['Lodging', 342.64, ['Service Tax 8% 24.64 on 332.64']],
      ['Meals', 99.11, ['SST 6% 5.61 on 99.11']],
    ]);
  });
  test('a row\'s `on` follows it when rows before it go', () => {
    const r = normalise({ total: 110, docType: 'meal', rows: [row('item', 'Cash', 200), row('item', 'Lunch', 100), row('tax', 'GST 10%', 10, { rate: 10, on: 1 })] });
    expect(shown(r)).toEqual([['item', 'Lunch', 100, null, false, null], ['tax', 'GST', 10, 10, false, 0]]);
    // A row under one that is not there, under itself or under a tax stands on its own.
    const bad = normalise({ total: 111, rows: [row('item', 'A', 100), row('tax', 'T', 10, { rate: 10, on: 7 }), row('charge', 'C', 1, { on: 1 })] });
    expect(bad.rows.map(x => x.on)).toEqual([null, null, null]);
  });
});

describe('a tax is called by its own name', () => {
  // The labels QA found reaching the case table and Xero: a date, a base, a
  // folio's code beside the name made one tax look like several.
  test.each([
    ['20/10 Service Tax 8%', 'Service Tax'], ['21/10 Service Tax 8%', 'Service Tax'], ['SST 6% on 40.80', 'SST'], ['SST 8% on 12.00', 'SST'],
    ['CGST 9%- Rooms-(New) -[Add. udf.]', 'CGST'], ['CGST 9%- Rooms-(New) -[Add: udf.]', 'CGST'], ['JW Cafe SGST 9% -[Add: 9%.(B)]', 'SGST'],
    ['enth. MwSt 7% (Logis 360,00)', 'MwSt'], ['12/10 GST 9% included', 'GST'], ['消費税(10%)', '消費税'], ['PB1 10%', 'PB1'],
  ])('"%s" is %s, in the case it is printed', (printedLabel, name) => {
    expect(normalise({ total: 1000, rows: [row('item', 'Room', 900), row('tax', printedLabel, 81, { rate: 9 })] }).rows[1].label).toBe(name);
  });
  test('a name it does not know is kept, without its rate', () => {
    expect(normalise({ total: 1000, rows: [row('item', 'Room', 900), row('tax', 'Kommunalabgabe 9%', 81, { rate: 9 })] }).rows[1].label).toBe('Kommunalabgabe');
  });
  test('two nights\' dated GST read as one tax on the line, charged on both nights', () => {
    const r = normalise({ total: 400, currency: 'SGD', country: 'SG', docType: 'hotel', category: 'Lodging', rows: [
      row('item', '12/10 Room Charge', 200, { category: 'Lodging' }), row('tax', '12/10 GST 9% incl.', 16.51, { rate: 9, included: true, on: 0 }),
      row('item', '13/10 Room Charge', 200, { category: 'Lodging' }), row('tax', '13/10 GST 9% incl.', 16.51, { rate: 9, included: true, on: 2 }),
    ] });
    expect(claimLines({ rows: r.rows, total: r.total }, 'Lodging')[0].taxes).toEqual([{ label: 'GST', rate: 9, amount: 33.02, included: true, gross: 400, basis: '0,2' }]);
  });
});

describe('the tax figure', () => {
  test('the receipt\'s own tax summary wins over the rows: the JW folio prints 6,759 against per-charge rows of 6,760', () => {
    const rows = [row('item', 'Accomodation Charges', 17575, { category: 'Lodging' }), row('tax', 'CGST 9%', 1581.75, { rate: 9, on: 0 }), row('tax', 'SGST 9%', 1581.75, { rate: 9, on: 0 }),
                  row('item', 'Upsell Breakfast', 1200, { category: 'Meals' }), row('tax', 'CGST 9%', 108, { rate: 9, on: 3 }), row('tax', 'SGST 9%', 109, { rate: 9, on: 3 })];
    expect(normalise({ total: 22155.5, taxTotal: 3379.5, docType: 'hotel', rows }).tax).toBe(3379.5);
    expect(normalise({ total: 22155.5, docType: 'hotel', rows }).tax).toBe(3380.5);
  });
  test('a summary that counts the service charge as tax, or that the complete rows contradict, gives way to the rows', () => {
    const nasi = [row('item', 'Nasi', 23.9), row('charge', 'Service Charge', 2.39, { rate: 10 }), row('tax', 'SST', 1.58, { rate: 6 }), row('rounding', 'Rounding', -0.02)];
    expect(normalise({ total: 27.85, taxTotal: 3.97, rows: nasi }).tax).toBe(1.58);
    const folio = [row('item', 'Room', 1000), row('tax', 'CGST', 90, { rate: 9 }), row('tax', 'SGST', 90, { rate: 9 })];
    expect(normalise({ total: 1180, taxTotal: 120, rows: folio }).tax).toBe(180);
  });
  test('a tax row more than its rate could make, or more than the total, is not believed', () => {
    // "(10%対象 ¥2,780)" under a ramen bill is the amount taxed, not a tax of 2,780.
    const r = normalise({ total: 3058, currency: 'JPY', rows: [row('item', 'Ramen', 2780), row('tax', '(10%対象', 2780, { rate: 10 }), row('tax', '消費税(10%)', 278, { rate: 10 })] });
    expect(shown(r)).toEqual([['item', 'Ramen', 2780, null, false, null], ['tax', '消費税', 278, 10, false, null]]);
    expect(normalise({ total: 10, rows: [row('item', 'A', 10), row('tax', 'VAT', 99)] }).rows.map(x => x.kind)).toEqual(['item']);
  });
  test('a levy named like a tax is a charge, and is not the tax', () => {
    const r = normalise({ total: 226, rows: [row('item', 'Room', 200), row('tax', 'Tourism Tax', 10), row('tax', 'SST 8%', 16, { rate: 8 })] });
    expect(r.rows.map(x => x.kind)).toEqual(['item', 'charge', 'tax']);
    expect(r.tax).toBe(16);
  });
});

describe('decision 2: a Singapore receipt that says its prices include GST and prints no amount', () => {
  const sg = { total: 10.9, currency: 'SGD', country: 'SG', date: '2026-10-01', gstIncluded: true, rows: [row('item', 'Sandwich', 10.9)] };
  test('gets GST 9% inside the prices, worked out as 9/109 and marked so', () => {
    const r = normalise(sg);
    expect(r.rows[1]).toEqual({ kind: 'tax', label: 'GST', qty: null, unitPrice: null, amount: 0.9, rate: 9, included: true, worked: true,
                                category: null, onBehalfOf: null, taxRate: null, on: null });
    expect(r.tax).toBe(0.9);
  });
  test('at the rate of the day: 8% in 2023', () => {
    expect(normalise({ ...sg, date: '2023-06-01' }).rows[1]).toMatchObject({ rate: 8, amount: 0.81 });
  });
  // The reader gave a folio's "GST 9% included 105.69", printed under its
  // TOTAL, only as the tax total and not as a row.
  test('a GST printed below the total and given only as the tax total is a row named GST, at the amount printed', () => {
    const r = normalise({ total: 1280, taxTotal: 105.69, currency: 'SGD', country: 'SG', date: '2026-10-14', gstIncluded: true, rows: [row('item', 'Room Charge', 1280)] });
    expect(r.rows[1]).toMatchObject({ kind: 'tax', label: 'GST', rate: 9, amount: 105.69, included: true, worked: false });
    // Elsewhere, or when the amount is not GST's share, it is a tax with no name to give it.
    expect(normalise({ total: 1280, taxTotal: 105.69, currency: 'MYR', country: 'MY', rows: [row('item', 'Room Charge', 1280)] }).rows[1]).toMatchObject({ label: 'Tax', rate: null, included: true });
    expect(normalise({ total: 1280, taxTotal: 50, currency: 'SGD', country: 'SG', rows: [row('item', 'Room Charge', 1280)] }).rows[1]).toMatchObject({ label: 'Tax', rate: null });
  });

  test('only then: not when an amount is printed, not without the words, and never for another country', () => {
    expect(normalise({ ...sg, rows: [...sg.rows, row('tax', 'GST', 0.9, { rate: 9, included: true })] }).rows.filter(x => x.worked)).toEqual([]);
    expect(normalise({ ...sg, gstIncluded: false }).rows).toHaveLength(1);
    expect(normalise({ ...sg, country: 'MY', currency: 'MYR' }).rows).toHaveLength(1);
    expect(normalise({ ...sg, country: 'AU', currency: 'AUD' }).rows).toHaveLength(1);
  });
});

describe('what the reader has always protected, on rows', () => {
  test('a tip under "Total" is part of the amount charged', () => {
    const r = normalise({ total: 111.5, rows: [row('item', 'Steak', 99), row('tax', 'Sales Tax', 8.54, { rate: 8.625 }), row('charge', 'SF Mandate', 3.96, { rate: 4 }), row('charge', 'Tip', 20)] });
    expect(r.total).toBe(131.5);
  });
  test('payments and restated totals are not rows', () => {
    const r = normalise({ total: 13.8, rows: [row('item', 'Rice', 13.8), row('item', 'Sub Total', 13.8), row('item', 'CASH', 20), row('item', 'CHANGE', 6.2), row('item', 'VISA ****1234', 13.8)] });
    expect(r.rows.map(x => x.label)).toEqual(['Rice']);
  });
  test('a folio transfer carries to the tax rows under it, and leaves the name', () => {
    const r = normalise({ total: 12331, category: 'Lodging', docType: 'hotel', rows: [
      row('item', 'Standard Retail [NA Room] LIM WEI JIE #126=>Rahman Aisha #110', 10450, { category: 'Lodging' }),
      row('tax', 'CGST ROOM 9%', 940.5, { rate: 9 }), row('tax', 'SGST ROOM 9%', 940.5, { rate: 9 }),
    ] });
    expect(r.rows.map(x => [x.label, x.onBehalfOf, x.on])).toEqual([['Standard Retail [NA Room]', 'Lim Wei Jie', null], ['CGST', 'Lim Wei Jie', 0], ['SGST', 'Lim Wei Jie', 0]]);
  });
  test('a refund keeps no rows, and no tax, however its tax total was read', () => {
    const r = normalise({ total: -43.44, taxTotal: 3.45, subTotal: 39.99, rows: [row('item', 'Ink', -39.99), row('tax', 'Sales Tax', -3.45, { rate: 8.625 })] });
    expect(r).toMatchObject({ total: null, tax: null, subTotal: null, refund: true, rows: [] });
  });
  test('a charge or a tax printed negative on a bill that is not a refund takes off, as a discount', () => {
    const r = normalise({ total: 98, rows: [row('item', 'Room', 100), row('charge', 'Service charge waived', -2)] });
    expect(r.rows.map(x => [x.kind, x.amount])).toEqual([['item', 100], ['discount', -2]]);
  });
  test('a discount takes off, and an item that takes off is a discount', () => {
    const r = normalise({ total: 21.4, rows: [row('item', 'Fare', 23.4), row('item', 'Promo GRABSAVE', -2)] });
    expect(r.rows.map(x => [x.kind, x.amount])).toEqual([['item', 23.4], ['discount', -2]]);
  });
});
