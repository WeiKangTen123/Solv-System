jest.mock('./receipt-parser', () => ({
  parseReceiptImage: jest.fn(), parseReceiptText: jest.fn(), parseReceiptPages: jest.fn(), parseReceiptBatch: jest.fn(),
}));
jest.mock('../pdf/render', () => ({ renderPdfPages: jest.fn() }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.01341, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: '2026-09-18T03:00:00.000Z' }) }));
jest.mock('../pdf/pages', () => ({
  extractPages: jest.fn(), splittablePages: jest.fn(() => ({ split: false, reason: 'single' })), sameDocument: jest.fn(() => false),
  pageHasText: jest.requireActual('../pdf/pages').pageHasText,
}));

describe('receipts/read-receipt', () => {
  let store, users, u, parser, render, pdfPages, read;
  const folio = {
    merchant: 'Courtyard By Marriott Pune Chakan', date: '2026-09-04', time: '08:23', currency: 'INR', total: 88188.77, tax: 13452.52,
    subTotal: null, invoiceNumber: '00/000-000001', category: 'Lodging', description: '[Lodging] Rooms and meals @ Courtyard', confidence: 'high', box: null,
    lineItems: [
      { description: 'Package', unitAmount: 36552, category: 'Lodging', onBehalfOf: null },
      { description: 'CGST/SGST ROOM', unitAmount: 6579.36, category: 'Lodging', onBehalfOf: null },
      { description: 'Standard Retail', unitAmount: 31113, category: 'Lodging', onBehalfOf: 'LIM WEI JIE' },
      { description: 'CGST/SGST ROOM (transfer)', unitAmount: 5600.34, category: 'Lodging', onBehalfOf: 'LIM WEI JIE' },
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
    [parser.parseReceiptImage, parser.parseReceiptText, parser.parseReceiptPages, parser.parseReceiptBatch, render.renderPdfPages, pdfPages.extractPages].forEach(f => f.mockReset());
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
      ['Lodging', null, 43131.36], ['Lodging', 'LIM WEI JIE', 36713.34], ['Meals', null, 8344.07],
    ]);
    expect(lines.reduce((s, l) => s + Math.round(l.amount * 100), 0)).toBe(8818877);
  });

  test('buildLines falls back to one line when the items do not add up', () => {
    const lines = read.buildLines({ ...folio, lineItems: [{ description: 'x', unitAmount: 5, category: 'Meals' }] }, 'Other');
    expect(lines).toEqual([{ category: 'Lodging', description: '[Lodging] Rooms and meals @ Courtyard', amount: 88188.77, onBehalfOf: null }]);
  });

  test('buildLines never writes a line of nothing or less: a residual bigger than the largest line means one line', () => {
    // Ten people's 10.00 against a total of 87.00 is inside the tolerance, and
    // the -13.00 residual on one 10.00 line used to make it -3.00.
    const items = Array.from({ length: 10 }, (_, i) => ({ description: `Dinner ${i}`, unitAmount: 10, category: 'Meals', onBehalfOf: `Guest ${i}` }));
    const lines = read.buildLines({ merchant: 'Jumbo', total: 87, category: 'Meals', description: '[Meals] Dinner @ Jumbo', lineItems: items }, 'Other');
    expect(lines).toEqual([{ category: 'Meals', description: '[Meals] Dinner @ Jumbo', amount: 87, onBehalfOf: null }]);
    expect(read.buildLines({ merchant: 'Jumbo', total: 99, category: 'Meals', lineItems: items }, 'Other').every(l => l.amount > 0)).toBe(true);
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
    expect(after.invoiceNo).toBe('00/000-000001');
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

  test('a PDF the text worker could not open is not drawn as well, and says so', async () => {
    // A broken or hanging file used to cost the text timeout and then the
    // render timeout, ninety seconds more, to land in the same place.
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: [], numPages: 0, hasText: false, textPageCount: 0, failed: true });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });
    expect(render.renderPdfPages).not.toHaveBeenCalled();
    expect(store.getExpense(e.id)).toMatchObject({ status: 'review-needed', errorMsg: expect.stringMatching(/could not be read automatically/) });
    expect(await read.readOne(u.id, Buffer.from('%PDF'), 'application/pdf')).toBeNull();
    expect(render.renderPdfPages).not.toHaveBeenCalled();
  });

  test('a text PDF whose pages are one document is read from the joined text', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: ['page one text of the Courtyard folio: rooms and meals', 'page two text of the Courtyard folio: taxes and the total'], numPages: 2, hasText: true, textPageCount: 2 });
    pdfPages.splittablePages.mockReturnValue({ split: false, pageNumbers: [], reason: 'pages of one document' });
    parser.parseReceiptText.mockResolvedValue({ receipts: [{ ...folio, lineItems: [] }], split: false });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });
    expect(parser.parseReceiptText.mock.calls[0][1]).toMatch(/page one text[\s\S]*page two text/);
    expect(store.getExpense(e.id).lines).toEqual([expect.objectContaining({ category: 'Lodging', amount: 88188.77 })]);
  });

  test('a text PDF of separate receipts becomes one expense per page', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: ['GRAB receipt one: Orchard Rd to Changi Airport, SGD 18.40', 'GOJEK receipt two: Changi Airport to Raffles Place, SGD 25.00'], numPages: 2, hasText: true, textPageCount: 2 });
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

  test('a suspicion of a duplicate raised by one read does not outlive the next', async () => {
    const first = seed();
    const grab = { merchant: 'Grab', date: '2026-09-01', total: 18.4, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] };
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [grab] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: first.r.id, expenseId: first.e.id, buffer: Buffer.from('a'), mime: 'image/jpeg' });
    const r2 = store.createReceipt({ companyId: u.companyId, userId: u.id, file: 'g.jpg', mime: 'image/jpeg', sha256: 'h2' });
    const e2 = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r2.id });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r2.id, expenseId: e2.id, buffer: Buffer.from('b'), mime: 'image/jpeg' });
    expect(store.getExpense(e2.id).duplicateOf).toBe(first.e.id);
    await read.applyRead(e2.id, { ...grab, total: 25 }, { reread: true }); read.flagIfSuspected(e2.id);
    const after = store.getExpense(e2.id);
    expect(after.duplicateOf).toBeNull();
    expect(after.errorMsg).toBeNull();
  });

  test('a receipt that names no currency keeps the base currency, with a note saying so until the currency is read', async () => {
    const { r, e } = seed();
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Corner Cafe', date: '2026-09-02', total: 18.4, currency: null, category: 'Meals', confidence: 'low', lineItems: [] }] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('a'), mime: 'image/jpeg' });
    let after = store.getExpense(e.id);
    expect(after.currency).toBe('SGD');
    expect(after.errorMsg).toMatch(/SGD was assumed/);
    expect(read.withoutCurrencyNote(after.errorMsg)).toBeNull();
    expect(read.withoutCurrencyNote(`${after.errorMsg} Possible duplicate of x — y. Check before submitting.`)).toBe('Possible duplicate of x — y. Check before submitting.');
    // A re-read that makes the currency out clears the note.
    await read.applyRead(e.id, { merchant: 'Corner Cafe', date: '2026-09-02', total: 18.4, currency: 'MYR', category: 'Meals', confidence: 'high', lineItems: [] }, { reread: true });
    after = store.getExpense(e.id);
    expect(after.currency).toBe('MYR');
    expect(after.errorMsg).toBeNull();
  });

  test('a scanned page holding two receipts splits like a photo', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: [''], numPages: 1, hasText: false, textPageCount: 0 });
    render.renderPdfPages.mockResolvedValue({ numPages: 1, pages: [{ page: 1, buffer: Buffer.from('p1'), width: 1240, height: 1754 }] });
    parser.parseReceiptPages.mockResolvedValue({ split: true, reason: null, receipts: [
      { merchant: 'A', total: 5, currency: 'SGD', category: 'Meals', confidence: 'high', box: [0, 0, 500, 1000], lineItems: [] },
      { merchant: 'B', total: 7, currency: 'SGD', category: 'Meals', confidence: 'high', box: [500, 0, 1000, 1000], lineItems: [] },
    ] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });
    const all = store.listExpenses({ receiptId: r.id }).sort((a, b) => a.merchant.localeCompare(b.merchant));
    expect(all.map(x => [x.merchant, x.box, x.status])).toEqual([['A', [0, 0, 500, 1000], 'review-needed'], ['B', [500, 0, 1000, 1000], 'review-needed']]);
    // Re-reading the second one picks the receipt nearest its box.
    const again = await read.readOne(u.id, Buffer.from('%PDF'), 'application/pdf', { box: [500, 0, 1000, 1000] });
    expect(again.merchant).toBe('B');
  });

  test('a first read that arrives after somebody moved the receipt on does not overwrite them', async () => {
    const { r, e } = seed();
    store.updateExpense(e.id, { status: 'review-needed', merchant: 'Typed by hand', total: 12.3 });
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Grab', date: '2026-09-01', total: 999.99, currency: 'SGD', category: 'Meals', confidence: 'high', lineItems: [] }] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('x'), mime: 'image/jpeg' });
    expect(store.getExpense(e.id)).toMatchObject({ merchant: 'Typed by hand', total: 12.3 });
  });

  test('the extra receipts found in one photo go into the same case, in the same currency', async () => {
    const { r, e } = seed();
    store.updateExpense(e.id, { currency: 'MYR' });
    const rep = require('../store/reports').createReport({ companyId: u.companyId, userId: u.id, title: 'Trip' });
    require('../store/reports').addExpense(rep.id, e.id);
    parser.parseReceiptImage.mockResolvedValue({ split: true, reason: null, receipts: [
      { merchant: 'A', date: '2026-09-01', total: 10, currency: 'MYR', category: 'Meals', confidence: 'high', lineItems: [], box: [0, 0, 500, 1000] },
      { merchant: 'B', date: '2026-09-01', total: 20, currency: null, category: 'Meals', confidence: 'high', lineItems: [], box: [500, 0, 1000, 1000] },
    ] });
    const out = await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('x'), mime: 'image/jpeg' });
    const sib = store.getExpense(out.expenseIds[1]);
    expect(sib).toMatchObject({ merchant: 'B', reportId: rep.id, currency: 'MYR' });
  });

  test('an extra receipt found after its case was claimed stays out of the case, with a note saying why', async () => {
    const { r, e } = seed();
    const reports = require('../store/reports');
    const rep = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Trip' });
    reports.addExpense(rep.id, e.id);
    // The case is claimed while the reader is still at work on the photo.
    parser.parseReceiptImage.mockImplementation(async () => {
      reports.setState(rep.id, { status: 'claimed', claimedAt: new Date().toISOString() });
      return { split: true, reason: null, receipts: [
        { merchant: 'A', date: '2026-09-01', total: 10, currency: 'SGD', category: 'Meals', confidence: 'high', lineItems: [], box: [0, 0, 500, 1000] },
        { merchant: 'B', date: '2026-09-01', total: 20, currency: 'SGD', category: 'Meals', confidence: 'high', lineItems: [], box: [500, 0, 1000, 1000] },
      ] };
    });
    const out = await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('x'), mime: 'image/jpeg' });
    const sib = store.getExpense(out.expenseIds[1]);
    expect(sib).toMatchObject({ merchant: 'B', total: 20, reportId: null, status: 'review-needed' });
    expect(sib.errorMsg).toMatch(new RegExp(`case ${rep.number}, which was claimed while it was being read`));
    expect(reports.getReport(rep.id).expenses.map(x => x.id)).toEqual([e.id]);
  });

  test('a typed cover sheet with scanned receipts behind it reads the scans too, and a long scan says what it skipped', async () => {
    const cover = 'EXPENSE CLAIM COVER SHEET Employee Aisha Rahman Department Sales Period September 2026 receipts attached';
    pdfPages.extractPages.mockResolvedValue({ pages: [cover, '', ''], numPages: 3, hasText: true, textPageCount: 1 });
    pdfPages.splittablePages.mockReturnValue({ split: false, pageNumbers: [], reason: 'fewer than two pages have readable text' });
    parser.parseReceiptText.mockResolvedValue({ split: false, receipts: [{ merchant: null, total: null, confidence: 'low', lineItems: [] }] });
    render.renderPdfPages.mockResolvedValue({ numPages: 3, pages: [2, 3].map(p => ({ page: p, buffer: Buffer.from(`p${p}`) })) });
    parser.parseReceiptBatch.mockResolvedValue([
      { split: false, receipts: [{ merchant: 'Grab', date: '2026-09-01', total: 18.4, currency: 'SGD', category: 'Meals', confidence: 'high', lineItems: [] }] },
      { split: false, receipts: [{ merchant: null, total: null, confidence: 'low', lineItems: [] }] },
    ]);
    const out = await read.readParts(u.id, Buffer.from('%PDF'), 'application/pdf');
    expect(out.parts.map(p => [p.page, p.r && p.r.merchant])).toEqual([[null, null], [2, 'Grab']]);      // null: the whole file
    // The scans are read together through the batch reader, as whole reads.
    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
    expect(parser.parseReceiptBatch.mock.calls[0][1]).toHaveLength(2);
    expect(parser.parseReceiptBatch.mock.calls[0][2]).toMatchObject({ split: true });
    expect(out.notes).toEqual(['No receipt was read on page 3; check it by hand.']);

    // A thick scan: pages with no receipt make no row, and are named.
    parser.parseReceiptBatch.mockReset();
    pdfPages.extractPages.mockResolvedValue({ pages: [], numPages: 30, hasText: false, textPageCount: 0 });
    render.renderPdfPages.mockResolvedValue({ numPages: 30, pages: Array.from({ length: 20 }, (_, i) => ({ page: i + 1, buffer: Buffer.from('x') })) });
    parser.parseReceiptBatch.mockResolvedValue(new Array(20).fill(null));
    const scan = await read.readParts(u.id, Buffer.from('%PDF'), 'application/pdf');
    expect(parser.parseReceiptBatch).toHaveBeenCalledTimes(1);          // five pages a call, inside the batch reader
    expect(scan.notes.join(' ')).toMatch(/Only the first 20 of 30 pages were read/);
    expect(scan.notes.join(' ')).toMatch(/No receipt was read on pages 1, 2, 3, .*, 20; check them by hand/);
    expect(scan.parts).toHaveLength(0);
  });

  test('a scan of three taxi receipts, one to a page, becomes three expenses, each on its page', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: ['', '', ''], numPages: 3, hasText: false, textPageCount: 0 });
    render.renderPdfPages.mockResolvedValue({ numPages: 3, pages: [1, 2, 3].map(p => ({ page: p, buffer: Buffer.from(`p${p}`) })) });
    const ride = (merchant, invoiceNumber, total, page) => ({ merchant, invoiceNumber, total, date: '2026-09-01', currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [], box: null, pages: [page] });
    parser.parseReceiptPages.mockResolvedValue({ split: true, reason: null, receipts: [ride('Grab', 'A1', 18.4, 1), ride('Grab', 'A2', 22.1, 2), ride('ComfortDelGro', null, 30.6, 3)] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });
    const all = store.listExpenses({ receiptId: r.id }).sort((a, b) => a.page - b.page);
    expect(all.map(x => [x.page, x.merchant, x.total, x.status])).toEqual([
      [1, 'Grab', 18.4, 'review-needed'], [2, 'Grab', 22.1, 'review-needed'], [3, 'ComfortDelGro', 30.6, 'review-needed'],
    ]);
  });

  test('pages the reader could not tell apart stay one expense, and a note says how many it saw', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: ['', ''], numPages: 2, hasText: false, textPageCount: 0 });
    render.renderPdfPages.mockResolvedValue({ numPages: 2, pages: [1, 2].map(p => ({ page: p, buffer: Buffer.from(`p${p}`) })) });
    parser.parseReceiptPages.mockResolvedValue({ split: false, reason: 'two entries may be one document', receipts: [folio, { ...folio, total: 100 }] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });
    expect(store.listExpenses({ receiptId: r.id })).toHaveLength(1);
    expect(store.getExpense(e.id)).toMatchObject({ total: 88188.77, errorMsg: expect.stringMatching(/saw 2 receipts in these pages/) });
  });

  test('every scanned page among typed ones is read, five to a call, and a page the renderer would not draw is named', async () => {
    const typed = 'TAX INVOICE Courtyard By Marriott Pune Chakan folio 00/000-000001 total INR 45,000.00';
    const pages = [typed, ...new Array(24).fill('')];                    // 24 scans behind one typed page
    pdfPages.extractPages.mockResolvedValue({ pages, numPages: 25, hasText: true, textPageCount: 1 });
    parser.parseReceiptText.mockResolvedValue({ split: false, receipts: [{ ...folio, total: 45000, lineItems: [] }] });
    // The renderer draws twenty pages at most.
    render.renderPdfPages.mockImplementation(async (buf, opts) => ({ numPages: 25, pages: opts.pages.slice(0, 20).map(p => ({ page: p, buffer: Buffer.from(`p${p}`) })) }));
    const two = { split: true, reason: null, receipts: [
      { merchant: 'A', total: 5, currency: 'SGD', box: [0, 0, 500, 1000], lineItems: [] },
      { merchant: 'B', total: 7, currency: 'SGD', box: [500, 0, 1000, 1000], lineItems: [] },
    ] };
    parser.parseReceiptBatch.mockImplementation(async (userId, images) => images.map((_, i) => (i === 0 ? two : { split: false, receipts: [{ merchant: `Shop ${i}`, total: 10 + i, lineItems: [] }] })));
    const out = await read.readParts(u.id, Buffer.from('%PDF'), 'application/pdf');
    expect(render.renderPdfPages.mock.calls[0][1].pages).toHaveLength(24);    // not the first ten
    expect(parser.parseReceiptBatch).toHaveBeenCalledTimes(1);
    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
    expect(out.notes.join(' ')).toMatch(/Only 20 of the 24 scanned pages were read/);
    // The typed folio, then page 2 split in two like a photo, then pages 3 to 21.
    expect(out.parts).toHaveLength(1 + 2 + 19);
    expect(out.parts.slice(1, 3).map(p => [p.page, p.r.merchant, p.box])).toEqual([[2, 'A', [0, 0, 500, 1000]], [2, 'B', [500, 0, 1000, 1000]]]);
    expect(out.parts.at(-1)).toMatchObject({ page: 21, r: { merchant: 'Shop 19' } });
  });

  test('a read that could not reach the AI service says so on the receipt, and the receipt is still released', async () => {
    const { r, e } = seed();
    parser.parseReceiptImage.mockResolvedValue({ receipts: [], split: false, reason: 'the reader could not reach the AI service', unavailable: true });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('x'), mime: 'image/jpeg' });
    const after = store.getExpense(e.id);
    expect(after.status).toBe('review-needed');
    expect(after.merchant).toBeNull();
    expect(after.errorMsg).toMatch(/could not reach the AI service.*Re-read/);
  });

  // The queue (read-queue.js) asks to be told rather than have the receipt
  // released, so it can try again itself in a few minutes.
  test('asked to put it off, a read that reached nobody touches nothing and says so', async () => {
    const { r, e } = seed();
    parser.parseReceiptImage.mockResolvedValue({ receipts: [], split: false, reason: 'the reader could not reach the AI service', unavailable: true });
    const out = await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('x'), mime: 'image/jpeg' }, { deferIfUnavailable: true });
    expect(out).toEqual({ unavailable: true });
    expect(store.getExpense(e.id)).toMatchObject({ status: 'reading', errorMsg: null });
    expect(store.getReceipt(r.id).parsedAt).toBeNull();
    expect(read.UNAVAILABLE_NOTE).toMatch(/could not reach the AI service/);
  });

  test('...but a read that got part of a thick scan lands as it is, with the note, and is not put off', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: Array(12).fill(''), numPages: 12, hasText: false, textPageCount: 0 });
    render.renderPdfPages.mockResolvedValue({ numPages: 12, pages: Array.from({ length: 12 }, (_, i) => ({ page: i + 1, buffer: Buffer.from(`p${i}`) })) });
    parser.parseReceiptBatch.mockResolvedValue(Array.from({ length: 12 }, (_, i) => (i === 0
      ? { receipts: [{ merchant: 'Grab', total: 9, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }], split: false }
      : { receipts: [], split: false, unavailable: true })));
    const out = await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' }, { deferIfUnavailable: true });
    expect(out.expenseIds).toEqual([e.id]);
    expect(store.getExpense(e.id)).toMatchObject({ status: 'review-needed', merchant: 'Grab', errorMsg: expect.stringMatching(/could not reach the AI service/) });
  });

  test('where and what the reader saw land on the expense and beside it in aiRead', async () => {
    const { r, e } = seed();
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Taj', date: '2026-09-04', total: 9000, currency: 'INR', category: 'Lodging', confidence: 'high', lineItems: [],
      city: 'Mumbai', country: 'IN', docType: 'hotel' }] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('x'), mime: 'image/jpeg' });
    const after = store.getExpense(e.id);
    expect(after).toMatchObject({ city: 'Mumbai', country: 'IN', docType: 'hotel' });
    expect(after.aiRead).toMatchObject({ city: 'Mumbai', country: 'IN', docType: 'hotel' });
  });

  test('what was worth a look is kept with what the reader read, and stays when the lines are edited', async () => {
    const { r, e } = seed();
    const item = (description, unitAmount, category, onBehalfOf = null) => ({ description, unitAmount, category, onBehalfOf });
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Harbourview', date: '2026-10-14', total: 1280, currency: 'SGD', category: 'Lodging', docType: 'hotel', country: 'SG', confidence: 'high',
      lineItems: [item('Room Charge', 560, 'Lodging'), item('Room Charge', 560, 'Lodging', 'Ong Mei Lin'), item('Breakfast CHECK# 5120', 32, 'Meals'), item('Breakfast CHECK# 5120', 32, 'Meals'), item('Dinner', 96, 'Meals')] }] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('x'), mime: 'image/jpeg' });
    const checks = store.getExpense(e.id).aiRead.checks;
    expect(checks).toEqual({ chargedTwice: [{ description: 'Breakfast CHECK# 5120', amount: 32, count: 2 }], people: ['Ong Mei Lin'], adjusted: null, dateOrder: null });
    store.replaceLines(e.id, [{ category: 'Lodging', amount: 1280, currency: 'SGD' }], { force: true });
    expect(store.getExpense(e.id).aiRead.checks.people).toEqual(['Ong Mei Lin']);
  });

  test('a read with its rows is kept as printed: the record, the reader\'s copy, and lines with their taxes', async () => {
    const { r, e } = seed();
    const row = (kind, label, amount, x = {}) => ({ kind, label, amount, qty: null, unitPrice: null, rate: null, included: false, worked: false,
      category: null, onBehalfOf: null, taxRate: null, on: null, ...x });
    const rows = [row('item', 'Room Charge', 280, { category: 'Lodging' }), row('charge', 'Service Charge', 28, { rate: 10, on: 0 }),
                  row('tax', 'Service Tax', 24.64, { rate: 8, on: 0 }), row('charge', 'Tourism Tax', 10, { on: 0 }),
                  row('item', 'Lounge Dinner', 85, { category: 'Meals' }), row('charge', 'Service Charge', 8.5, { rate: 10, on: 4 }),
                  row('tax', 'SST', 5.61, { rate: 6, on: 4 })];
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Hotel Seri Bukit', date: '2026-10-21', total: 441.75, tax: 30.25, subTotal: null,
      currency: 'MYR', category: 'Lodging', docType: 'hotel', country: 'MY', confidence: 'high', rows, lineItems: [] }] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('x'), mime: 'image/jpeg' });
    const after = store.getExpense(e.id);
    expect(after).toMatchObject({ total: 441.75, tax: 30.25, subTotal: null });
    expect(after.printed).toEqual({ v: 1, rows, subtotal: null, total: 441.75 });
    expect(after.aiRead.printed).toEqual(after.printed);
    expect(after.lines.map(l => [l.category, l.amount, l.taxes])).toEqual([
      ['Lodging', 342.64, [{ label: 'Service Tax', rate: 8, amount: 24.64, included: false, gross: 332.64 }]],
      ['Meals', 99.11, [{ label: 'SST', rate: 6, amount: 5.61, included: false, gross: 99.11 }]],
    ]);
  });

  test('a read in the older shape, or with no amount, keeps no record and the lines are as before', async () => {
    const { r, e } = seed();
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [folio] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('x'), mime: 'image/jpeg' });
    const after = store.getExpense(e.id);
    expect(after.printed).toBeNull();
    expect(after.aiRead.printed).toBeNull();
    expect(after.lines.map(l => [l.category, l.amount, l.taxes])).toEqual([['Lodging', 43131.36, null], ['Lodging', 36713.34, null], ['Meals', 8344.07, null]]);
  });

  test('a refund is read as no amount, with a note that says why', async () => {
    const { r, e } = seed();
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Office Depot', date: '2026-10-21', total: null, refund: true, currency: 'USD', category: 'Office Supplies', confidence: 'high', lineItems: [] }] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('x'), mime: 'image/jpeg' });
    const after = store.getExpense(e.id);
    expect(after).toMatchObject({ merchant: 'Office Depot', total: 0, errorMsg: read.REFUND_NOTE, lines: [] });
    expect(read.REFUND_NOTE).toBe('This looks like a refund; refunds are not claimed here.');
  });
});

describe('receipts/read-receipt — the difference to the total, and the read-time checks', () => {
  const { buildLines, readChecks } = require('./read-receipt');
  const item = (description, unitAmount, category, onBehalfOf = null) => ({ description, unitAmount, category, onBehalfOf });
  const shown = r => buildLines(r, 'Other').map(l => [l.category, l.onBehalfOf, l.amount]);

  test('a dinner the reader missed goes on the claimant\'s own line in the receipt\'s category, never a colleague\'s', () => {
    // It used to go on the largest line: the colleague's room.
    const folio = { merchant: 'Hotel', total: 1300, category: 'Lodging', lineItems: [item('Room', 500, 'Lodging'), item('Room', 600, 'Lodging', 'Colleague A'), item('Dinner', 100, 'Meals')] };
    expect(shown(folio)).toEqual([['Lodging', null, 600], ['Lodging', 'Colleague A', 600], ['Meals', null, 100]]);
    expect(readChecks(folio, buildLines(folio, 'Other')).adjusted).toEqual({ amount: 100, pct: 7.7 });
  });

  test('with no line of the claimant\'s own in that category, one is made for the difference', () => {
    const r = { merchant: 'Hotel', description: '[Lodging] Rooms @ Hotel', total: 1010, category: 'Lodging', lineItems: [item('Room', 1000, 'Lodging', 'Colleague A')] };
    expect(buildLines(r, 'Other')).toEqual([
      { category: 'Lodging', description: 'Room', amount: 1000, onBehalfOf: 'Colleague A' },
      { category: 'Lodging', description: '[Lodging] Rooms @ Hotel', amount: 10, onBehalfOf: null },
    ]);
    // Rounding within 2% is not worth a look.
    expect(readChecks(r, buildLines(r, 'Other')).adjusted).toBeNull();
  });

  test('a difference the claimant\'s own line cannot carry puts the total on one line', () => {
    const r = { merchant: 'Jumbo', total: 99, category: 'Meals', description: '[Meals] Dinner @ Jumbo', lineItems: Array.from({ length: 10 }, (_, i) => item(`Dinner ${i}`, 10, 'Meals', `Guest ${i}`)) };
    expect(buildLines(r, 'Other')).toEqual([{ category: 'Meals', description: '[Meals] Dinner @ Jumbo', amount: 99, onBehalfOf: null }]);
  });

  // The subtotal and tax are what the receipt printed, and are not held
  // against its total any more.
  test('the printed subtotal and tax are not second-guessed', () => {
    expect(readChecks({ subTotal: 2780, tax: 300, total: 3058, lineItems: [] }, [])).not.toHaveProperty('subtotalMismatch');
  });

  test('a read kept as printed is judged by its rows: rows short of the total were adjusted, and a tax is never charged twice', () => {
    const row = (kind, label, amount, x = {}) => ({ kind, label, amount, onBehalfOf: null, included: false, ...x });
    const r = { total: 27.85, rows: [row('item', 'Nasi Kandar', 14.5), row('item', 'Teh Tarik', 3.2), row('item', 'Teh Tarik', 3.2), row('charge', 'Service Charge', 2.39),
                                     row('tax', 'SST', 1.58), row('tax', 'SST', 1.58)] };
    expect(readChecks(r, [])).toMatchObject({ chargedTwice: [{ description: 'Teh Tarik', amount: 3.2, count: 2 }], adjusted: { amount: 1.4, pct: 5 } });
    // An included tax is in the prices: rows that add up with it left out were not adjusted.
    const sg = { total: 13.8, rows: [row('item', 'Chicken Rice', 13.8), row('tax', 'GST', 1.14, { included: true })] };
    expect(readChecks(sg, []).adjusted).toBeNull();
  });

  test('the same charge for the same person twice is named once, with its count; taxes and colleagues\' twins are not', () => {
    const r = { total: 3000, lineItems: [
      item('MoMo Cafe Dinner Food  Room# 110 : CHECK# 11603631', 1296.25, 'Meals'), item('MoMo Cafe Dinner Food Room# 110 : CHECK# 11603631', 1296.25, 'Meals'),
      item('CGST Momo Cafe F&B 9%', 139.15, 'Meals'), item('CGST Momo Cafe F&B 9%', 139.15, 'Meals'),
      item('Accomodation Charges', 17575, 'Lodging'), item('Accomodation Charges', 17575, 'Lodging', 'Lim Wei Jie'),
      item('Promo', -2, 'Meals'), item('Promo', -2, 'Meals'),
    ] };
    expect(readChecks(r, []).chargedTwice).toEqual([{ description: 'MoMo Cafe Dinner Food Room# 110 : CHECK# 11603631', amount: 1296.25, count: 2 }]);
  });

  test('the other people are those the lines carry', () => {
    const lines = [{ onBehalfOf: null }, { onBehalfOf: 'Lim Wei Jie' }, { onBehalfOf: 'Lim Wei Jie' }, { onBehalfOf: 'Tan Ah Kow' }];
    expect(readChecks({ total: 1 }, lines).people).toEqual(['Lim Wei Jie', 'Tan Ah Kow']);
  });

  test('a month-first date whose day could be its month reads two ways', () => {
    const d = r => readChecks({ total: 10, ...r }, []).dateOrder;
    expect(d({ date: '2026-10-09', country: 'US', datePrinted: '10/09/2026' })).toEqual({ read: '2026-10-09', other: '2026-09-10' });
    expect(d({ date: '2026-10-09', country: 'PH', dateOrder: 'MDY' })).toEqual({ read: '2026-10-09', other: '2026-09-10' });
    expect(d({ date: '2026-10-09', country: 'US' })).toEqual({ read: '2026-10-09', other: '2026-09-10' });
    // Not when the day is over 12, the two are the same, the month is a word,
    // the year comes first, the receipt is day-first, or the other day is to come.
    expect(d({ date: '2026-10-21', country: 'US', datePrinted: '10/21/2026' })).toBeNull();
    expect(d({ date: '2026-10-10', country: 'US', datePrinted: '10/10/2026' })).toBeNull();
    expect(d({ date: '2026-10-09', country: 'US', datePrinted: 'Oct 9, 2026' })).toBeNull();
    expect(d({ date: '2026-10-09', country: 'US', datePrinted: '2026-10-09' })).toBeNull();
    expect(d({ date: '2026-10-09', country: 'SG', datePrinted: '09/10/2026', dateOrder: 'DMY' })).toBeNull();
    expect(d({ date: '2025-01-12', country: 'US', datePrinted: '01/12/2025' })).toEqual({ read: '2025-01-12', other: '2025-12-01' });
    expect(d({ date: '2099-10-12', country: 'US', datePrinted: '10/12/2099' })).toBeNull();   // 10 December 2099 has not happened
  });

  test('a read with nothing to remark on has empty checks, and no read has none', () => {
    expect(readChecks({ total: 10, lineItems: [item('Latte', 10, 'Meals')] }, [{ onBehalfOf: null }])).toEqual({ chargedTwice: [], people: [], adjusted: null, dateOrder: null });
    expect(readChecks(null, [])).toBeNull();
  });
});

describe('receipts/read-receipt — reading one part of a file again', () => {
  let parser, render, pdfPages, read;
  const typed = 'TAX INVOICE Courtyard By Marriott Pune Chakan folio 00/000-000001 page one of the charges';
  const typedLast = 'TAX INVOICE Courtyard By Marriott Pune Chakan folio 00/000-000001 page two total INR 45,000.00';
  const mixed = { pages: [typed, typedLast, ''], numPages: 3, hasText: true, textPageCount: 2 };
  const grab = { merchant: 'Grab', total: 18.4, currency: 'SGD', lineItems: [] };

  beforeEach(() => {
    jest.resetModules();
    parser = require('./receipt-parser'); render = require('../pdf/render'); pdfPages = require('../pdf/pages');
    read = require('./read-receipt');
    [parser.parseReceiptImage, parser.parseReceiptText, parser.parseReceiptPages, parser.parseReceiptBatch, render.renderPdfPages, pdfPages.extractPages].forEach(f => f.mockReset());
    pdfPages.splittablePages.mockReset(); pdfPages.splittablePages.mockReturnValue({ split: false, reason: 'pages of one document' });
  });

  test('a scanned page among typed ones is drawn and read as an image, not sent to the text reader empty', async () => {
    pdfPages.extractPages.mockResolvedValue(mixed);
    render.renderPdfPages.mockResolvedValue({ numPages: 3, pages: [{ page: 3, buffer: Buffer.from('p3') }] });
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [grab] });
    const r = await read.readOne('u1', Buffer.from('%PDF'), 'application/pdf', { page: 3 });
    expect(r.merchant).toBe('Grab');
    expect(render.renderPdfPages.mock.calls[0][1]).toEqual({ pages: [3] });
    expect(parser.parseReceiptText).not.toHaveBeenCalled();
  });

  test('the folio beside the scans is read whole again, whether its row says page null or the old pinned page', async () => {
    pdfPages.extractPages.mockResolvedValue(mixed);
    parser.parseReceiptText.mockResolvedValue({ split: false, receipts: [{ merchant: 'Courtyard', total: 45000, lineItems: [] }] });
    expect((await read.readOne('u1', Buffer.from('%PDF'), 'application/pdf', { page: null })).total).toBe(45000);
    expect((await read.readOne('u1', Buffer.from('%PDF'), 'application/pdf', { page: 1 })).total).toBe(45000);
    for (const [, text] of parser.parseReceiptText.mock.calls) expect(text).toMatch(/page one[\s\S]*total INR 45,000/);
    // Typed pages that were separate receipts are still read one page at a time.
    pdfPages.splittablePages.mockReturnValue({ split: true, pageNumbers: [1, 2], reason: null });
    await read.readOne('u1', Buffer.from('%PDF'), 'application/pdf', { page: 2 });
    expect(parser.parseReceiptText.mock.calls.at(-1)[1]).toBe(typedLast);
  });

  test('a receipt kept apart in a short scan is found again by its pages, or read from its page alone', async () => {
    pdfPages.extractPages.mockResolvedValue({ pages: ['', '', ''], numPages: 3, hasText: false, textPageCount: 0 });
    render.renderPdfPages.mockImplementation(async (buf, opts) => ({ numPages: 3, pages: (opts.pages || [1, 2, 3]).map(p => ({ page: p, buffer: Buffer.from(`p${p}`) })) }));
    parser.parseReceiptPages.mockResolvedValue({ split: true, reason: null, receipts: [
      { merchant: 'Grab', total: 18.4, pages: [1], box: null, lineItems: [] },
      { merchant: 'Courtyard', total: 45000, pages: [2, 3], box: null, lineItems: [] },
    ] });
    // The second receipt's row is on page 2; its total is on page 3.
    expect((await read.readOne('u1', Buffer.from('%PDF'), 'application/pdf', { page: 2 })).total).toBe(45000);
    expect(parser.parseReceiptPages.mock.calls[0][1]).toHaveLength(3);
    // A re-read that no longer keeps them apart reads the row's page on its own.
    parser.parseReceiptPages.mockResolvedValue({ split: false, reason: 'two entries may be one document', receipts: [{ merchant: 'Courtyard', total: 45018.4, lineItems: [] }] });
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [grab] });
    expect((await read.readOne('u1', Buffer.from('%PDF'), 'application/pdf', { page: 1 })).merchant).toBe('Grab');
    expect(render.renderPdfPages.mock.calls.at(-1)[1]).toEqual({ pages: [1] });
  });

  test('one half of a split photo is never re-read with the other half\'s figures', async () => {
    const A = { merchant: 'A', total: 5, box: [0, 0, 500, 1000], lineItems: [] };
    const B = { merchant: 'B', total: 7, box: [500, 0, 1000, 1000], lineItems: [] };
    const again = async receipts => {
      parser.parseReceiptImage.mockResolvedValue({ split: receipts.length > 1, receipts });
      return read.readOne('u1', Buffer.from('x'), 'image/jpeg', { box: [500, 0, 1000, 1000] });
    };
    expect((await again([A, B])).merchant).toBe('B');
    expect((await again([A, { ...B, box: [480, 20, 990, 980] }])).merchant).toBe('B');   // boxes move a little between reads
    expect(await again([A])).toBeNull();                                                // only the other half was found
    expect(await again([{ ...B, box: null }])).toBeNull();                              // found, but nowhere to be placed
    // A row that owns no region takes the first, as before.
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [A] });
    expect((await read.readOne('u1', Buffer.from('x'), 'image/jpeg')).merchant).toBe('A');
  });
});
