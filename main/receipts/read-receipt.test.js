jest.mock('./receipt-parser', () => ({
  parseReceiptImage: jest.fn(), parseReceiptText: jest.fn(), parseReceiptPages: jest.fn(),
}));
jest.mock('../pdf/render', () => ({ renderPdfPages: jest.fn() }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.01341, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: '2026-09-18T03:00:00.000Z' }) }));
jest.mock('../pdf/pages', () => ({
  extractPages: jest.fn(), splittablePages: jest.fn(() => ({ split: false, reason: 'single' })), sameDocument: jest.fn(() => false),
}));

describe('receipts/read-receipt', () => {
  let store, users, u, parser, render, pdfPages, read;
  const folio = {
    merchant: 'Courtyard By Marriott Pune Chakan', date: '2026-09-04', time: '08:23', currency: 'INR', total: 88188.77, tax: 13452.52,
    subTotal: null, invoiceNumber: '93/713-181024', category: 'Lodging', description: '[Lodging] Rooms and meals @ Courtyard', confidence: 'high', box: null,
    lineItems: [
      { description: 'Package', unitAmount: 36552, category: 'Lodging', onBehalfOf: null },
      { description: 'CGST/SGST ROOM', unitAmount: 6579.36, category: 'Lodging', onBehalfOf: null },
      { description: 'Standard Retail', unitAmount: 31113, category: 'Lodging', onBehalfOf: 'TAN SUAN KUAN' },
      { description: 'CGST/SGST ROOM (transfer)', unitAmount: 5600.34, category: 'Lodging', onBehalfOf: 'TAN SUAN KUAN' },
      { description: 'MoMo Cafe', unitAmount: 8344.07, category: 'Meals', onBehalfOf: null },
    ],
  };

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses');
    parser = require('./receipt-parser'); render = require('../pdf/render'); pdfPages = require('../pdf/pages');
    read = require('./read-receipt');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
    [parser.parseReceiptImage, parser.parseReceiptText, parser.parseReceiptPages, render.renderPdfPages, pdfPages.extractPages].forEach(f => f.mockReset());
    pdfPages.splittablePages.mockReset(); pdfPages.splittablePages.mockReturnValue({ split: false, reason: 'single' });
  });
  const seed = (mime = 'image/jpeg') => {
    const r = store.createReceipt({ companyId: u.companyId, userId: u.id, file: `f.${mime === 'application/pdf' ? 'pdf' : 'jpg'}`, mime, sha256: 'h' });
    const e = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, currency: 'SGD' });
    return { r, e };
  };

  test('buildLines groups by category and on-behalf and reconciles to the cent', () => {
    const lines = read.buildLines(folio, 'Other');
    expect(lines.map(l => [l.category, l.onBehalfOf, l.amount])).toEqual([
      ['Lodging', null, 43131.36], ['Lodging', 'TAN SUAN KUAN', 36713.34], ['Meals', null, 8344.07],
    ]);
    expect(lines.reduce((s, l) => s + Math.round(l.amount * 100), 0)).toBe(8818877);
  });

  test('buildLines falls back to one line when the items do not add up', () => {
    const lines = read.buildLines({ ...folio, lineItems: [{ description: 'x', unitAmount: 5, category: 'Meals' }] }, 'Other');
    expect(lines).toEqual([{ category: 'Lodging', description: '[Lodging] Rooms and meals @ Courtyard', amount: 88188.77, onBehalfOf: null }]);
  });

  test('a scanned PDF is rendered and read as one document across pages', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: ['', '', '', ''], numPages: 4, hasText: false, textPageCount: 0 });
    render.renderPdfPages.mockResolvedValue({ numPages: 4, pages: [1, 2, 3, 4].map(p => ({ page: p, buffer: Buffer.from(`p${p}`), width: 1240, height: 1754 })) });
    parser.parseReceiptPages.mockResolvedValue({ receipts: [folio], split: false, reason: 'pages of one document' });

    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });

    expect(parser.parseReceiptPages).toHaveBeenCalledTimes(1);
    expect(parser.parseReceiptPages.mock.calls[0][1]).toHaveLength(4);
    const after = store.getExpense(e.id);
    expect(after.status).toBe('review-needed');
    expect(after.merchant).toBe('Courtyard By Marriott Pune Chakan');
    expect(after.total).toBe(88188.77);
    expect(after.invoiceNo).toBe('93/713-181024');
    expect(after.currency).toBe('INR');
    expect(after.lines).toHaveLength(3);
    expect(after.baseTotal).toBe(1182.61);
    expect(after.lines[0].fxSource).toBe('frankfurter');
    expect(store.listExpenses({ receiptId: r.id })).toHaveLength(1);      // one expense, not four
    expect(store.getReceipt(r.id).pages).toBe(4);
    expect(store.getReceipt(r.id).parsedAt).toBeTruthy();
  });

  test('a scanned PDF that cannot be rendered is left for the user with a note', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: [''], numPages: 1, hasText: false, textPageCount: 0 });
    render.renderPdfPages.mockResolvedValue(null);
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });
    const after = store.getExpense(e.id);
    expect(after.status).toBe('review-needed');
    expect(after.errorMsg).toMatch(/could not be read/i);
    expect(parser.parseReceiptPages).not.toHaveBeenCalled();
  });

  test('a text PDF whose pages are one document is read from the joined text', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: ['page one text', 'page two text'], numPages: 2, hasText: true, textPageCount: 2 });
    pdfPages.splittablePages.mockReturnValue({ split: false, pageNumbers: [], reason: 'pages of one document' });
    parser.parseReceiptText.mockResolvedValue({ receipts: [{ ...folio, lineItems: [] }], split: false });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });
    expect(parser.parseReceiptText.mock.calls[0][1]).toMatch(/page one text[\s\S]*page two text/);
    expect(store.getExpense(e.id).lines).toEqual([expect.objectContaining({ category: 'Lodging', amount: 88188.77 })]);
  });

  test('a text PDF of separate receipts becomes one expense per page', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: ['grab one', 'grab two'], numPages: 2, hasText: true, textPageCount: 2 });
    pdfPages.splittablePages.mockReturnValue({ split: true, pageNumbers: [1, 2], reason: null });
    parser.parseReceiptText
      .mockResolvedValueOnce({ receipts: [{ merchant: 'Grab', total: 18.4, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }] })
      .mockResolvedValueOnce({ receipts: [{ merchant: 'Gojek', total: 25, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });
    const all = store.listExpenses({ receiptId: r.id }).sort((a, b) => a.page - b.page);
    expect(all.map(x => [x.page, x.merchant])).toEqual([[1, 'Grab'], [2, 'Gojek']]);
  });

  test('a photo of two receipts splits when the parser says the evidence is clean', async () => {
    const { r, e } = seed();
    parser.parseReceiptImage.mockResolvedValue({ split: true, reason: null, receipts: [
      { merchant: 'A', total: 5, currency: 'SGD', category: 'Meals', confidence: 'high', box: [0, 0, 500, 1000], lineItems: [] },
      { merchant: 'B', total: 7, currency: 'SGD', category: 'Meals', confidence: 'high', box: [500, 0, 1000, 1000], lineItems: [] },
    ] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('jpg'), mime: 'image/jpeg' });
    const all = store.listExpenses({ receiptId: r.id }).sort((a, b) => a.merchant.localeCompare(b.merchant));
    expect(all.map(x => [x.merchant, x.box])).toEqual([['A', [0, 0, 500, 1000]], ['B', [500, 0, 1000, 1000]]]);
    expect(all.every(x => x.status === 'review-needed')).toBe(true);
  });

  test('an unreadable photo survives at review-needed with blank fields', async () => {
    const { r, e } = seed();
    parser.parseReceiptImage.mockResolvedValue(null);
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('jpg'), mime: 'image/jpeg' });
    const after = store.getExpense(e.id);
    expect(after.status).toBe('review-needed');
    expect(after.merchant).toBeNull();
    expect(store.getReceipt(r.id).parsedAt).toBeTruthy();
  });

  test('a second receipt with the same merchant, date and amount is flagged, never auto-marked', async () => {
    const first = seed();
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Grab', date: '2026-09-01', total: 18.4, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: first.r.id, expenseId: first.e.id, buffer: Buffer.from('a'), mime: 'image/jpeg' });
    const r2 = store.createReceipt({ companyId: u.companyId, userId: u.id, file: 'g.jpg', mime: 'image/jpeg', sha256: 'h2' });
    const e2 = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r2.id });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r2.id, expenseId: e2.id, buffer: Buffer.from('b'), mime: 'image/jpeg' });
    const after = store.getExpense(e2.id);
    expect(after.status).toBe('review-needed');
    expect(after.duplicateOf).toBe(first.e.id);
    expect(after.errorMsg).toMatch(/Possible duplicate/);
  });
});
