const { normalise, SYSTEM_PROMPT } = require('./receipt-parser');
const { buildLines } = require('./read-receipt');

// The reading problems found on 2026-10-28 (docs/plans/2026-10-28-details-
// activity-reading.md, "A. Reading accuracy"), each as the reader's answer
// that showed it. A line item is written the way the model returns one.
const li = (description, lineTotal, category = null, onBehalfOf = null) => ({ description, unitAmount: lineTotal, quantity: 1, lineTotal, category, onBehalfOf });
const lines = r => buildLines(r, 'Other').map(l => `${l.category}${l.onBehalfOf ? '/OB' : ''}=${l.amount}`).sort();

describe('P1 tax lines: a tax by its own name, at the start of the line', () => {
  // A Kuala Lumpur nasi kandar bill: SST 1.58 and a service charge of 2.39.
  const nasi = [li('Nasi Kandar', 14.5, 'Meals'), li('Roti Canai', 3, 'Meals'), li('Teh Tarik', 6.4, 'Meals'), li('Service Charge 10%', 2.39, 'Meals'), li('SST 6%', 1.58, 'Meals'), li('Rounding Adj', -0.02, 'Meals')];

  test('SST is a tax, and a model figure that adds the service charge to it is put right', () => {
    expect(normalise({ total: 27.85, tax: 3.97, lineItems: nasi }).tax).toBe(1.58);
    expect(normalise({ total: 27.85, tax: null, lineItems: nasi }).tax).toBe(1.58);
    const renamed = nasi.map(x => (x.description === 'SST 6%' ? { ...x, description: 'Service Tax 6%' } : x));
    expect(normalise({ total: 27.85, tax: 3.97, lineItems: renamed }).tax).toBe(1.58);
  });

  test.each(['PPN 11%', 'PB1 10%', '消費税(10%)', 'MwSt 19%', 'HST 13%', 'IVA 16%', 'TVA 20%', 'VAT 7%', 'Sales Tax 8.625%', 'CGST 9%', 'GST/HST'])('a lone "%s" line gives the tax the model left out', name => {
    expect(normalise({ total: 110, tax: null, lineItems: [li('Food', 100), li(name, 10)] }).tax).toBe(10);
  });

  test('a city, tourism or hotel levy is not tax, and does not replace the right VAT', () => {
    const berlin = [li('Logis / Room', 180, 'Lodging'), li('Logis / Room', 180, 'Lodging'), li('Breakfast', 24, 'Meals'), li('City Tax 5%', 18, 'Lodging')];
    expect(normalise({ total: 402, tax: 27.38, lineItems: berlin }).tax).toBe(27.38);
    expect(normalise({ total: 226, tax: 16, lineItems: [li('Room', 200), li('Tourism Tax', 10), li('Service charge', 0), li('SST 8%', 16)] }).tax).toBe(16);
  });

  test('a charge whose text names a tax, or says tax-free, is not tax', () => {
    expect(normalise({ total: 238, tax: 19.65, lineItems: [li('Room charge (incl. GST)', 218), li('Breakfast', 20)] }).tax).toBe(19.65);
    expect(normalise({ total: 60, tax: 0, lineItems: [li('Tax free shopping', 50), li('Bag', 10)] }).tax).toBe(0);
    expect(normalise({ total: 60, tax: null, lineItems: [li('Tax free shopping', 50), li('Bag', 10)] }).tax).toBeNull();
  });

  test('one tax line never overrides the model\'s figure; two or more on a complete bill do', () => {
    // One line read as 8.00 against the model's 9.90: the model read it too.
    expect(normalise({ total: 117.9, tax: 9.9, lineItems: [li('Food', 100), li('Service charge', 10), li('GST 9%', 7.9)] }).tax).toBe(9.9);
    const folio = [li('Room', 1000), li('CGST 9%', 90), li('SGST 9%', 90)];
    expect(normalise({ total: 1180, tax: 120, lineItems: folio }).tax).toBe(180);
  });
});

describe('P2 a tax already inside the prices is a row, and is not added again', () => {
  test('the hawker\'s "GST 9% (incl.)" is kept as an included row, out of the lines, and is the tax', () => {
    const r = normalise({ total: 13.8, tax: 1.14, subTotal: 13.8, category: 'Meals', lineItems: [li('Chicken Rice', 11, 'Meals'), li('Barley', 1.8, 'Meals'), li('Egg', 1, 'Meals'), li('GST 9% (incl.)', 1.14, 'Meals')] });
    expect(r.lineItems.map(x => x.description)).toEqual(['Chicken Rice', 'Barley', 'Egg']);
    expect(r.rows[3]).toMatchObject({ kind: 'tax', label: 'GST', rate: 9, amount: 1.14, included: true });
    // The subtotal as printed, not total − tax.
    expect(r).toMatchObject({ tax: 1.14, subTotal: 13.8 });
    expect(lines(r)).toEqual(['Meals=13.8']);
  });

  test('a tax inside the prices read as added is put inside them, when the rest adds up without it', () => {
    const r = normalise({ total: 13.8, currency: 'SGD', rows: [{ kind: 'item', label: 'Chicken Rice', amount: 13.8 }, { kind: 'tax', label: 'GST', rate: 9, amount: 1.14, included: false }] });
    expect(r.rows[1]).toMatchObject({ included: true });
    expect(r.tax).toBe(1.14);
  });

  test('a Berlin hotel\'s two "enth. MwSt" lines leave the lines; room and breakfast keep their own amounts', () => {
    const de = [li('Logis / Room', 180, 'Lodging'), li('Logis / Room', 180, 'Lodging'), li('Breakfast', 24, 'Meals'), li('City Tax 5%', 18, 'Lodging'), li('enth. MwSt 7%', 23.55, 'Lodging'), li('enth. MwSt 19%', 3.83, 'Meals')];
    const r = normalise({ total: 402, tax: 27.38, category: 'Lodging', lineItems: de });
    expect(r.lineItems).toHaveLength(4);
    expect(r.tax).toBe(27.38);
    expect(lines(r)).toEqual(['Lodging=378', 'Meals=24']);
  });

  test('a tax that was added stays a line', () => {
    const r = normalise({ total: 36.16, tax: 4.16, lineItems: [li('Poutine', 12), li('Club Sandwich', 16.5), li('Coffee', 3.5), li('HST 13%', 4.16)] });
    expect(r.lineItems).toHaveLength(4);
  });

  test('the prompt asks for an included tax as a row, marked included', () => {
    expect(SYSTEM_PROMPT).toMatch(/a tax already inside\s+the prices too \(marked included\)/);
  });
});

describe('P3 discounts and rounding stay negative in their category', () => {
  test('the supermarket\'s "2ND UNIT 50% OFF" comes off the office supplies, and the groceries are their own', () => {
    const r = normalise({ total: 56.73, tax: 4.68, subTotal: 56.73, category: 'Office Supplies', lineItems: [
      li('MILK', 6.95, 'Meals'), li('BREAD', 3.2, 'Meals'), li('EGGS', 4.15, 'Meals'), li('APPLES', 3.2, 'Meals'), li('COFFEE', 15.9, 'Meals'), li('DISH LIQUID', 4.5, 'Other'),
      li('A4 PAPER 2x6.90', 13.8, 'Office Supplies'), li('2ND UNIT 50% OFF', -3.45, 'Office Supplies'), li('PENS', 5.6, 'Office Supplies'), li('BANANA', 2.88, 'Meals'),
    ] });
    expect(r.lineItems.find(x => /50% OFF/.test(x.description)).unitAmount).toBe(-3.45);
    expect(lines(r)).toEqual(['Meals=36.28', 'Office Supplies=15.95', 'Other=4.5']);
  });

  test('a discount larger than 15% of the bill still lands on its own category', () => {
    const r = normalise({ total: 140, category: 'Meals', lineItems: [li('Monitor', 100, 'Office Supplies'), li('Team lunch', 100, 'Meals'), li('Promo 30% off', -60, 'Office Supplies')] });
    expect(lines(r)).toEqual(['Meals=100', 'Office Supplies=40']);
  });

  test('a category that comes to nothing or less is not a line', () => {
    const r = normalise({ total: 20, category: 'Meals', lineItems: [li('Lunch', 20, 'Meals'), li('Voucher', -5, 'Other')] });
    expect(lines(r)).toEqual(['Meals=20']);
  });
});

describe('P5 dates are read in the country\'s order', () => {
  const us = { total: 131.5, country: 'US', datePrinted: '10/09/2026' };
  test('a US receipt\'s 10/09/2026 is 9 October, whatever the model made of it', () => {
    expect(normalise({ ...us, date: '2026-09-10', dateOrder: 'DMY' }).date).toBe('2026-10-09');
    expect(normalise({ ...us, date: '2026-10-09', dateOrder: 'MDY' }).date).toBe('2026-10-09');
    expect(normalise({ ...us, date: null }).date).toBe('2026-10-09');
  });

  test('elsewhere the order the model gives is used, and with none the model\'s date stands', () => {
    expect(normalise({ total: 13.8, country: 'SG', datePrinted: '05/10/2026', dateOrder: 'DMY', date: '2026-05-10' }).date).toBe('2026-10-05');
    expect(normalise({ total: 13.8, country: 'PH', datePrinted: '10/05/2026', dateOrder: 'MDY', date: '2026-05-10' }).date).toBe('2026-10-05');
    expect(normalise({ total: 13.8, country: 'SG', datePrinted: '05/10/2026', date: '2026-10-05' }).date).toBe('2026-10-05');
    expect(normalise({ total: 3058, country: 'JP', datePrinted: '2026年10月15日', dateOrder: 'YMD', date: '2026-10-15' }).date).toBe('2026-10-15');
  });

  test('a printed date that is another day altogether leaves the model\'s date alone', () => {
    // A folio's arrival day against its bill date.
    expect(normalise({ total: 1280, country: 'SG', datePrinted: '12/10/2026', dateOrder: 'DMY', date: '2026-10-14' }).date).toBe('2026-10-14');
  });

  test('how it was printed rides with the read, and nothing else does', () => {
    const r = normalise({ ...us, date: '2026-10-09', dateOrder: 'mdy' });
    expect(r).toMatchObject({ datePrinted: '10/09/2026', dateOrder: 'MDY' });
    expect(normalise({ total: 5, dateOrder: 'sometimes' })).not.toHaveProperty('dateOrder');
    expect(SYSTEM_PROMPT).toMatch(/- datePrinted:/);
    expect(SYSTEM_PROMPT).toMatch(/United States prints the month first/);
  });
});

describe('P6 a tip is part of the amount charged', () => {
  const items = [li('Steak', 42), li('Salmon', 34), li('Tea', 9), li('Salad', 14), li('Sales Tax', 8.54), li('SF Mandate', 3.96)];
  test('the "Total" before the tip, with the tip among the lines, becomes the amount charged', () => {
    const r = normalise({ total: 111.5, tax: 8.54, category: 'Meals', lineItems: [...items, li('Tip', 20)] });
    expect(r.total).toBe(131.5);
    expect(lines(r)).toEqual(['Meals=131.5']);
  });
  test('a total that already holds the tip is left as it is', () => {
    expect(normalise({ total: 131.5, lineItems: [...items, li('Gratuity', 20)] }).total).toBe(131.5);
    expect(normalise({ total: 111.5, lineItems: items }).total).toBe(111.5);
  });
  test('the prompt says so, and to prefer the larger grand total', () => {
    expect(SYSTEM_PROMPT).toMatch(/A tip or gratuity is part of\s+the amount charged/);
    expect(SYSTEM_PROMPT).toMatch(/GRAND TOTAL/);
  });
});

// The subtotal used to be rewritten as total − tax whenever it equalled the
// total, which put a figure on the receipt that it never printed.
describe('P7 the subtotal is as printed, never worked out', () => {
  test('a subtotal equal to the total stays the total; none printed is none', () => {
    expect(normalise({ total: 100, subTotal: 100, tax: null, lineItems: [li('Room', 91.74), li('GST 9%', 8.26)] })).toMatchObject({ tax: 8.26, subTotal: 100 });
    expect(normalise({ total: 13.8, subTotal: 13.8, tax: 1.14 }).subTotal).toBe(13.8);
    expect(normalise({ total: 109, subTotal: 100, tax: 9 }).subTotal).toBe(100);
    expect(normalise({ total: 109, tax: 9 }).subTotal).toBeNull();
  });
  test('above the total only when something came off after it', () => {
    expect(normalise({ total: 80, subTotal: 100, rows: [{ kind: 'item', label: 'Lunch', amount: 100 }, { kind: 'discount', label: 'Voucher', amount: -20 }] }).subTotal).toBe(100);
    expect(normalise({ total: 80, subTotal: 100, rows: [{ kind: 'item', label: 'Lunch', amount: 80 }] }).subTotal).toBeNull();
  });
});

describe('P8 currencies are real ISO codes', () => {
  test.each([['RMB', 'CNY'], ['YEN', 'JPY'], ['NTD', 'TWD'], ['RM', 'MYR'], ['S$', 'SGD'], ['sgd', 'SGD'], ['XXX', null], ['DOLLARS', null], ['$', null]])('%s → %s', (said, code) => {
    expect(normalise({ total: 10, currency: said }).currency).toBe(code);
  });
});

describe('P9 what is a payment and what is a charge', () => {
  test('a visa FEE is a charge; the Visa card is not', () => {
    const r = normalise({ total: 2816.5, lineItems: [li('Tourist Visa Fee (Single Entry)', 1800), li('VFS Service Fee', 950), li('VAT 7% on Service Fee', 66.5), li('Paid by VISA ****7731', 2816.5), li('VISA ****7731', 2816.5)] });
    expect(r.lineItems.map(x => x.description)).toEqual(['Tourist Visa Fee (Single Entry)', 'VFS Service Fee', 'VAT']);
    expect(r.rows[2]).toMatchObject({ kind: 'tax', label: 'VAT', rate: 7, amount: 66.5 });
  });

  test('cash handed over and change given are not charges', () => {
    const r = normalise({ total: 13.8, category: 'Meals', lineItems: [li('Chicken rice', 11, 'Meals'), li('Barley', 1.8, 'Meals'), li('Egg', 1, 'Meals'), li('Cash', 20, 'Meals'), li('Change', 6.2, 'Meals')] });
    expect(r.lineItems.map(x => x.description)).toEqual(['Chicken rice', 'Barley', 'Egg']);
    expect(normalise({ total: 196350, lineItems: [li('Nasi Goreng', 196350 - 3650), li('Es Teh', 3650), li('Tunai', 200000), li('Kembali', 3650)] }).lineItems).toHaveLength(2);
  });

  test('a real charge equal to the total is kept, beside a line of nothing', () => {
    expect(normalise({ total: 200, lineItems: [li('Room', 200, 'Lodging'), li('Service charge', 0, 'Lodging')] }).lineItems.map(x => x.description)).toEqual(['Room', 'Service charge']);
    expect(normalise({ total: 18.4, lineItems: [li('Ride fare', 18.4)] }).lineItems).toHaveLength(1);
  });

  test('a total restated as a line goes when the others make it up, and "Total" or "Subtotal" always', () => {
    expect(normalise({ total: 30, lineItems: [li('A', 10), li('B', 20), li('Bank transfer', 30)] }).lineItems.map(x => x.description)).toEqual(['A', 'B']);
    expect(normalise({ total: 30, lineItems: [li('A', 10), li('B', 20), li('Sub Total', 30), li('TOTAL', 30)] }).lineItems.map(x => x.description)).toEqual(['A', 'B']);
  });
});

describe('P10 categories', () => {
  test('a reader\'s word for a category is the category', () => {
    expect(normalise({ total: 10, category: 'Hotel', lineItems: [li('Room', 10, 'Accommodation')] })).toMatchObject({ category: 'Lodging', lineItems: [expect.objectContaining({ category: 'Lodging' })] });
    expect(normalise({ total: 10, category: 'Taxi' }).category).toBe('Air & Transport');
    expect(normalise({ total: 10, category: 'F&B' }).category).toBe('Meals');
  });

  test('on a hotel folio a room rate read as Office Supplies (or software, or medical) is the folio\'s category', () => {
    const r = normalise({ total: 1000, category: 'Lodging', docType: 'hotel', lineItems: [li('Standard Retail', 800, 'Office Supplies'), li('Spa', 100, 'Medical/Dental'), li('Wifi', 50, 'Software/Utilities'), li('Dinner', 50, 'Meals')] });
    expect(r.lineItems.map(x => x.category)).toEqual(['Lodging', 'Lodging', 'Lodging', 'Meals']);
    // Off a folio, a line is what the reader said it was.
    expect(normalise({ total: 100, category: 'Meals', docType: 'other', lineItems: [li('Pens', 100, 'Office Supplies')] }).lineItems[0].category).toBe('Office Supplies');
  });
});

describe('P11 amounts as printed in other countries', () => {
  test.each([['12,50', 12.5], ['1.234,56', 1234.56], ['Rp 1.250.000', 1250000], ['1 234,56', 1234.56], ['(5.00)', -5], ['12.80-', -12.8], ['1,00,000', 100000], ['S$1,234.50', 1234.5]])('"%s" is %d', (printed, value) => {
    expect(normalise({ total: '9999', lineItems: [{ description: 'x', lineTotal: printed }] }).lineItems[0].unitAmount).toBe(value);
  });
  test('a total printed with a decimal comma', () => {
    expect(normalise({ total: 'EUR 402,00' }).total).toBe(402);
  });
});

describe('P12 people on hotel folios', () => {
  test('a tax line at the head of a new page belongs to the transferred charge it follows', () => {
    // The Pune folio: page 1 ends with "CGST ROOM 9% 940.50", its transfer at the top of page 2.
    const r = normalise({ total: 12331, category: 'Lodging', docType: 'hotel', lineItems: [
      li('Standard Retail [NA Room] LIM WEI JIE #126=>Rahman Aisha Mei Ling #110', 10450, 'Lodging'),
      li('CGST ROOM 9%', 940.5, 'Lodging'),
      li('SGST ROOM 9% [Add; udf.] LIM WEI JIE #126=>Rahman Aisha Mei Ling #110', 940.5, 'Lodging'),
      li('Package', 0, 'Lodging'),
      li('CGST ROOM 9%', 0, 'Lodging'),
    ] });
    expect(r.lineItems.map(x => x.onBehalfOf)).toEqual(['Lim Wei Jie', 'Lim Wei Jie', 'Lim Wei Jie', null, null]);
    expect(lines(r)).toEqual(['Lodging/OB=12331']);
  });

  test('a description printed over several lines is one line, and its guest is whole', () => {
    const r = normalise({ total: 675, docType: 'hotel', lineItems: [li('MoMo Cafe Dinner Food\nRoom# 128 : CHECK# 11603551 [pbhun211] LIM WEI\nJIE #126=>Rahman Aisha #110', 675, 'Meals')] });
    expect(r.lineItems[0]).toMatchObject({ description: 'MoMo Cafe Dinner Food Room# 128 : CHECK# 11603551 [pbhun211]', onBehalfOf: 'Lim Wei Jie' });
  });

  test('off a folio, a tax line is not given to anyone', () => {
    const r = normalise({ total: 110, docType: 'meal', lineItems: [li('Lunch', 100, 'Meals', 'Guest A'), li('GST 10%', 10, 'Meals')] });
    expect(r.lineItems[1].onBehalfOf).toBeNull();
  });

  test('the prompt keeps the whole printed description, across a page', () => {
    expect(SYSTEM_PROMPT).toMatch(/copy the WHOLE description/);
    expect(SYSTEM_PROMPT).toMatch(/continues at the top of the next page/);
  });
});

describe('refunds are not claimed', () => {
  test('a negative total is a refund, with no amount', () => {
    const r = normalise({ merchant: 'Office Depot', total: -43.44, tax: -3.45, subTotal: -39.99, lineItems: [li('HP 67XL Ink', -39.99), li('Sales Tax 8.625%', -3.45)] });
    expect(r).toMatchObject({ total: null, tax: null, subTotal: null, refund: true });
    expect(buildLines(r, 'Other')).toEqual([]);
  });
  test('so is a receipt whose every charge is negative, whatever sign the total came with', () => {
    expect(normalise({ total: 43.44, lineItems: [li('HP 67XL Ink', -39.99), li('Sales Tax', -3.45)] })).toMatchObject({ total: null, refund: true });
  });
  test('a receipt with a discount is not a refund', () => {
    expect(normalise({ total: 21.4, lineItems: [li('Fare', 23.4), li('Promo', -2)] })).not.toHaveProperty('refund');
    expect(normalise({ total: 0 })).not.toHaveProperty('refund');
  });
});
