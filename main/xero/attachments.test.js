
describe('xero/attachments', () => {
  let attachments, receiptStore;
  beforeEach(() => { jest.resetModules(); attachments = require('./attachments'); receiptStore = require('../receipts/receipt-store'); });

  test('a small image and a small PDF are attached as they are', async () => {
    const files = receiptStore.forUser('att-user');
    const jpgName = files.save('a1', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 1]), 'image/jpeg');
    const out = await attachments.forReceipt({ id: 'a1', userId: 'att-user', file: jpgName, mime: 'image/jpeg' }, { ref: 'R3' });
    expect(out).toEqual([expect.objectContaining({ name: 'R3.jpg', mime: 'image/jpeg' })]);
    const pdfName = files.save('a2', await require('../test-fixtures/make-pdf').scannedPdf(2), 'application/pdf');
    const pdf = await attachments.forReceipt({ id: 'a2', userId: 'att-user', file: pdfName, mime: 'application/pdf' }, { ref: 'R1' });
    expect(pdf).toEqual([expect.objectContaining({ name: 'R1.pdf', mime: 'application/pdf' })]);
    expect(pdf[0].buffer.length).toBeLessThanOrEqual(attachments.MAX_BYTES);
  }, 60000);

  test('an image over the limit is re-encoded under it', async () => {
    const sharp = require('sharp');
    const big = await sharp({ create: { width: 1800, height: 1800, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png({ compressionLevel: 0 }).toBuffer();
    expect(big.length).toBeGreaterThan(attachments.MAX_BYTES);
    const files = receiptStore.forUser('att-user');
    const name = files.save('a3', big, 'image/png');
    const out = await attachments.forReceipt({ id: 'a3', userId: 'att-user', file: name, mime: 'image/png' }, { ref: 'R2' });
    expect(out).toHaveLength(1);
    expect(out[0].mime).toBe('image/jpeg');
    expect(out[0].buffer.length).toBeLessThanOrEqual(attachments.MAX_BYTES);
  }, 60000);

  test('a missing file yields nothing rather than an error', async () => {
    expect(await attachments.forReceipt({ id: 'x', userId: 'att-user', file: 'gone.jpg', mime: 'image/jpeg' })).toEqual([]);
  });
});

// More receipt files than Xero takes on one bill: the case PDF instead, cut
// between receipts into as few files as fit.
describe('xero/attachments — casePdfs', () => {
  let attachments, doc, exporter, sharp;
  beforeEach(() => {
    jest.resetModules();
    attachments = require('./attachments'); doc = require('../reports/expense-doc'); exporter = require('../reports/expense-export'); sharp = require('sharp');
  });
  const pages = buf => Number(/\/Type \/Pages\s+\/Count (\d+)/.exec(buf.toString('latin1'))[1]);
  // A noisy picture, which JPEG cannot make small: its weight is what it is.
  async function picture(edge, seed = 0, quality = 90) {
    const jpg = await sharp({ create: { width: edge, height: edge, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 + seed } } }).jpeg({ quality }).toBuffer();
    return { dataUri: `data:image/jpeg;base64,${jpg.toString('base64')}`, bytes: jpg.length };
  }
  const caseOf = receipts => ({
    company: { id: 'c1', name: 'Solv Pte Ltd', baseCurrency: 'SGD', timezone: 'Asia/Singapore', reportColumns: ['Meals'] },
    report: { number: 'EXP-2026-0002', title: 'India trip', kind: 'trip', status: 'claimed', claimedAt: '2026-09-10T06:02:00Z' },
    owner: { name: 'Aisha' },
    lines: receipts.map((r, i) => ({ ref: r.ref, date: '2026-09-04', merchant: `Cafe ${i + 1}`, category: 'Meals', currency: 'SGD', amount: 10, fxRate: 1, baseAmount: 10 })),
    receipts, generatedAt: Date.parse('2026-09-10T06:02:00Z'),
  });
  async function receipts(n, edge) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ ref: `R${i + 1}`, title: `Cafe ${i + 1}`, pages: [await picture(edge, i)] });
    return out;
  }
  const coverPages = async payload => pages(await exporter.pdfBuffer(doc.expenseReportDoc({ ...payload, receipts: [] })));

  test('a case that fits is one file: the export\'s own document, the cover and then every receipt', async () => {
    const payload = caseOf(await receipts(3, 300));
    const out = await attachments.casePdfs(payload);
    expect(out.left).toEqual([]);
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toMatchObject({ name: 'EXP-2026-0002 receipts 1-3.pdf', mime: 'application/pdf', refs: ['R1', 'R2', 'R3'] });
    const exported = await exporter.pdfBuffer(doc.expenseReportDoc(payload));
    expect(pages(out.files[0].buffer)).toBe(pages(exported));
    expect(pages(out.files[0].buffer)).toBe(await coverPages(payload) + 3);
  }, 60000);

  test('cut between receipts into as few files as fit, in order, the cover in the first', async () => {
    const list = await receipts(6, 500);
    const heaviest = Math.max(...list.map(r => r.pages[0].bytes));
    const payload = caseOf(list);
    const cover = (await exporter.pdfBuffer(doc.expenseReportDoc({ ...payload, receipts: [] }))).length;
    // Room for two receipts and the cover, never three.
    const maxBytes = Math.round(cover + heaviest * 2.6);
    const out = await attachments.casePdfs(payload, { maxBytes });
    expect(out.left).toEqual([]);
    expect(out.files.map(f => f.name)).toEqual(['EXP-2026-0002 receipts 1-2.pdf', 'EXP-2026-0002 receipts 3-4.pdf', 'EXP-2026-0002 receipts 5-6.pdf']);
    for (const f of out.files) expect(f.buffer.length).toBeLessThanOrEqual(maxBytes);
    const cp = await coverPages(payload);
    expect(out.files.map(f => pages(f.buffer))).toEqual([cp + 2, 2, 2]);
  }, 60000);

  test('more than the files allowed: as many receipts as fit go, and the rest are named', async () => {
    const list = await receipts(6, 500);
    const heaviest = Math.max(...list.map(r => r.pages[0].bytes));
    const payload = caseOf(list);
    const cover = (await exporter.pdfBuffer(doc.expenseReportDoc({ ...payload, receipts: [] }))).length;
    const out = await attachments.casePdfs(payload, { maxBytes: Math.round(cover + heaviest * 2.6), maxFiles: 2 });
    expect(out.files.map(f => f.refs)).toEqual([['R1', 'R2'], ['R3', 'R4']]);
    expect(out.left).toEqual(['R5', 'R6']);
  }, 60000);

  test('a receipt too heavy for a file on its own is drawn smaller to fit; one that cannot be is left out and named', async () => {
    const heavy = await picture(1800, 0, 95);
    const maxBytes = Math.round(heavy.bytes / 2);
    const light = await picture(200, 1);
    const payload = caseOf([{ ref: 'R1', title: 'Folio', pages: [heavy] }, { ref: 'R2', title: 'Cafe', pages: [light] }]);
    const out = await attachments.casePdfs(payload, { maxBytes });
    expect(out.left).toEqual([]);
    expect(out.files.map(f => f.name)).toEqual(['EXP-2026-0002 receipts 1-2.pdf']);
    expect(out.files[0].buffer.length).toBeLessThanOrEqual(maxBytes);

    // A folio of four such pages is still over 100 KB at its smallest.
    const folio = caseOf([{ ref: 'R1', title: 'Folio', pages: [heavy, heavy, heavy, heavy] }, { ref: 'R2', title: 'Cafe', pages: [await picture(100, 1)] }]);
    const tiny = await attachments.casePdfs(folio, { maxBytes: 60 * 1024 });
    expect(tiny.left).toEqual(['R1']);
    expect(tiny.files.map(f => f.name)).toEqual(['EXP-2026-0002 receipt 2.pdf']);
    expect(pages(tiny.files[0].buffer)).toBe(await coverPages(folio) + 1);
  }, 120000);
});
