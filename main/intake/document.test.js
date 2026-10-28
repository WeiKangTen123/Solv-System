const { detectCurrency, currencyCode, CURRENCY_CODES } = require('./document');

// What a receipt actually prints, for the places staff travel. The AI reader
// takes whatever three-letter code it reads, so this only governs documents
// read as text — but that is the path a hotel folio with a text layer takes.
describe('intake/document currency detection', () => {
  const cases = [
    ['Total Rp 1.250.000',            'IDR', 'Indonesian rupiah by symbol'],
    ['TỔNG CỘNG 1.200.000 ₫',         'VND', 'dong by symbol'],
    ['Grand Total VND 12,000,000',    'VND', 'dong by code'],
    ['ยอดรวม ฿4,500.00',               'THB', 'baht'],
    ['Total ₱2,340.00',               'PHP', 'peso'],
    ['합계 ₩45,000',                    'KRW', 'won'],
    ['Total ₹44,309.00',              'INR', 'rupee by symbol'],
    ['Amount NT$1,200',               'TWD', 'new Taiwan dollar'],
    ['Total HK$980.00',               'HKD', 'Hong Kong dollar'],
    ['TOTAL RM 128.90',               'MYR', 'ringgit'],
    ['Total S$128.90',                'SGD', 'Singapore dollar'],
    ['Total ¥12,345',                 'JPY', 'yen'],
    ['Currency: IDR',                 'IDR', 'a labelled code'],
    ['Charged USD 240.00',            'USD', 'a code beside the amount'],
    // "US$" contains "S$" and "CA$" contains "A$": both used to be misread.
    ['Total US$240.00',               'USD', 'US dollar, not SGD'],
    ['Total CA$99.00',                'CAD', 'Canadian dollar, not AUD'],
    ['Total A$99.00',                 'AUD', 'Australian dollar'],
  ];
  test.each(cases)('%s → %s (%s)', (text, want) => {
    expect(detectCurrency(text)).toBe(want);
  });

  test('a bare dollar sign names no currency, because six countries print it', () => {
    expect(detectCurrency('Total $88.00')).toBeNull();
  });

  test('nothing is guessed from a document that does not say', () => {
    expect(detectCurrency('Thank you for staying with us')).toBeNull();
    expect(detectCurrency('')).toBeNull();
    expect(detectCurrency(null)).toBeNull();
  });

  test('the codes the providers are asked for are the ones staff travel with', () => {
    for (const c of ['SGD', 'USD', 'MYR', 'IDR', 'VND', 'JPY', 'INR', 'THB', 'PHP', 'CNY', 'HKD', 'KRW', 'TWD', 'AED']) {
      expect(CURRENCY_CODES).toContain(c);
    }
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length); // no duplicates
    for (const c of CURRENCY_CODES) expect(c).toMatch(/^[A-Z]{3}$/);
  });

  test('currencyCode accepts any real ISO code, so the reader is not held to the list', () => {
    expect(currencyCode('mnt')).toBe('MNT');
    expect(currencyCode('  brl ')).toBe('BRL');
    expect(currencyCode('dollars')).toBeNull();
    expect(currencyCode('')).toBeNull();
  });

  test('...but not three letters that are no currency, and what a receipt prints for one is that one', () => {
    for (const c of ['XXX', 'ABC', 'RMX']) expect(currencyCode(c)).toBeNull();
    expect([currencyCode('RMB'), currencyCode('yen'), currencyCode('NTD'), currencyCode('RM'), currencyCode('Rp')]).toEqual(['CNY', 'JPY', 'TWD', 'MYR', 'IDR']);
    expect([currencyCode('S$'), currencyCode('US$'), currencyCode('CA$'), currencyCode('Euro')]).toEqual(['SGD', 'USD', 'CAD', 'EUR']);
    // Several countries print these.
    expect([currencyCode('$'), currencyCode('¥')]).toEqual([null, null]);
  });
});

describe('intake/document amounts as printed', () => {
  const { num, normaliseLineItem } = require('./document');
  test.each([
    ['1,234.56', 1234.56], ['1.234,56', 1234.56], ['12,50', 12.5], ['1 234,56', 1234.56], ['Rp 1.250.000', 1250000], ['1.200.000', 1200000],
    ['Rp 1.250', 1250], ['1,00,000', 100000], ['88,188.77', 88188.77], ['¥3,058', 3058], ['S$12.80', 12.8], ['RM24.35', 24.35], ['US$ 131.50', 131.5],
    ['€ 402,00', 402], ['(5.00)', -5], ['12.80-', -12.8], ['-2.00', -2], ['-S$ 2.00', -2], ['1.234', 1.234], [42, 42],
  ])('%s → %d', (printed, value) => expect(num(printed)).toBe(value));

  test('what is not one amount is nothing', () => {
    for (const v of ['2 x 4.50', 'abc', '', null, '2026-10-05', '1234,567', Infinity]) expect(num(v)).toBeNull();
  });

  test('a discount line keeps its minus', () => {
    expect(normaliseLineItem({ description: '2ND UNIT 50% OFF', lineTotal: -3.45 }).unitAmount).toBe(-3.45);
    expect(normaliseLineItem({ description: 'Promo', lineTotal: '(2.00)' }).unitAmount).toBe(-2);
  });
});

describe('intake/categories: a reader\'s words for a category', () => {
  const { canonicalCategory, CATEGORY_NAMES } = require('./categories');
  test.each([['Hotel', 'Lodging'], ['Accommodation', 'Lodging'], ['Transport', 'Air & Transport'], ['Air and Transport', 'Air & Transport'], ['Taxi', 'Air & Transport'],
    ['Food', 'Meals'], ['F&B', 'Meals'], ['Meals & Entertainment', 'Meals'], ['Stationery', 'Office Supplies'], ['Petrol', 'Fuel/Mileage'], ['Misc', 'Other'], ['Lodging.', 'Lodging']])('%s → %s', (said, name) => {
    expect(canonicalCategory(said)).toBe(name);
  });
  test('a word that could be two categories, or none, is nothing; every listed name is itself', () => {
    for (const w of ['Groceries', 'Gas', 'Bribes', '']) expect(canonicalCategory(w)).toBeNull();
    for (const n of CATEGORY_NAMES) expect(canonicalCategory(n)).toBe(n);
  });
});
