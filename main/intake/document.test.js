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

  test('currencyCode accepts any three-letter code, so the reader is not held to the list', () => {
    expect(currencyCode('mnt')).toBe('MNT');
    expect(currencyCode('  brl ')).toBe('BRL');
    expect(currencyCode('dollars')).toBeNull();
    expect(currencyCode('')).toBeNull();
  });
});
