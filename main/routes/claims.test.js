const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');
const zlib    = require('zlib');
const ExcelJS = require('exceljs');

// The model is mocked throughout: what is under test is the route and the
// records it writes, not the vision read.
jest.mock('../receipts/receipt-parser', () => ({
  parseReceiptBatch: jest.fn(async (userId, images) => images.map(() => null)),
  parseReceiptImage: jest.fn().mockResolvedValue(null),
  parseReceiptText:  jest.fn().mockResolvedValue(null),
  parseReceiptPages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../pdf/render', () => ({ renderPdfPages: jest.fn().mockResolvedValue(null) }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 1, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'frankfurter', fetchedAt: 'x' }) }));
jest.mock('../claims/claim-categories', () => ({ suggestCategories: jest.fn().mockResolvedValue([]) }));

// A minimal store-only zip.
function makeZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = zlib.crc32 ? zlib.crc32(body) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(body.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

async function makeForm(rows) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('C');
  const h = ws.getRow(7);
  h.getCell(1).value = 'No'; h.getCell(2).value = 'DATE'; h.getCell(3).value = 'DESCRIPTION OF EXPENSES';
  h.getCell(8).value = 'Currency'; h.getCell(9).value = 'Amount';
  rows.forEach((r, i) => {
    const x = ws.getRow(9 + i);
    x.getCell(1).value = r.no; x.getCell(2).value = new Date(r.date + 'T00:00:00Z');
    x.getCell(3).value = r.description; x.getCell(8).value = 'SGD'; x.getCell(9).value = r.amount;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const jpegBytes = tail => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, tail]);
// What the photo reader answers for an image holding one receipt.
const one = r => ({ receipts: [r], split: false, reason: 'single' });

describe('routes/claims', () => {
  let app, users, jwtSecret, testUser, store, receiptStore, claimImport, parser;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    store = require('../store/expenses');
    receiptStore = require('../receipts/receipt-store');
    claimImport = require('../claims/claim-import');
    claimImport._reset();
    require('../claims/claim-worker')._reset();
    parser = require('../receipts/receipt-parser');
    parser.parseReceiptImage.mockReset();
    parser.parseReceiptImage.mockResolvedValue(null);
    testUser = await users.createUser({ email: `c${Date.now()}@solv.sg`, password: 'password123' });
    app = express();
    app.use(express.json({ limit: '30mb' }));
    app.use('/api/claims', require('./claims'));
  });
  afterAll(() => { try { require('../claims/claim-worker')._reset(); } catch {} });

  const auth = (u = testUser) => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const b64 = b => b.toString('base64');
  const rowsOf = groupId => store.listExpenses({ groupId });

  async function finish(jobId, u = testUser) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const res = await request(serverFor(app)).get(`/api/claims/import/${jobId}`).set('Authorization', auth(u));
      if (['done', 'failed', 'cancelled'].includes(res.body.stage)) return res.body;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('import did not finish');
  }
  const start = (body, u = testUser) => request(serverFor(app)).post('/api/claims/import').set('Authorization', auth(u)).send(body);

  describe('POST /import', () => {
    test('requires authentication', async () => { await request(serverFor(app)).post('/api/claims/import').send({ archives: [] }).expect(401); });
    test('refuses an upload with nothing attached', async () => { await start({ archives: [], forms: [] }).expect(400); await start({}).expect(400); });
    test('refuses data that is not base64', async () => {
      const res = await start({ archives: [{ name: 'c.zip', data: 'not base64 !!' }] }).expect(400);
      expect(res.body.error).toMatch(/c\.zip/);
    });
    test('returns a job id immediately', async () => {
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(1) }]);
      const res = await start({ archives: [{ name: 'c.zip', data: b64(zip) }] }).expect(202);
      expect(res.body.jobId).toBeTruthy();
      await finish(res.body.jobId);
    });
    test('one job belongs to one user', async () => {
      const other = await users.createUser({ email: `o${Date.now()}@solv.sg`, password: 'password123', companyId: testUser.companyId });
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(2) }]);
      const { body } = await start({ archives: [{ name: 'c.zip', data: b64(zip) }] }).expect(202);
      await request(serverFor(app)).get(`/api/claims/import/${body.jobId}`).set('Authorization', auth(other)).expect(404);
      await finish(body.jobId);
    });
    test('GET /active reports a running job and null afterwards', async () => {
      const idle = await request(serverFor(app)).get('/api/claims/active').set('Authorization', auth()).expect(200);
      expect(idle.body.job).toBeNull();
      let release;
      const holdOpen = new Promise(resolve => { release = resolve; });
      parser.parseReceiptImage.mockImplementationOnce(async () => { await holdOpen; return null; });
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(3) }]);
      const { body } = await start({ archives: [{ name: 'c.zip', data: b64(zip) }] }).expect(202);
      const active = await request(serverFor(app)).get('/api/claims/active').set('Authorization', auth()).expect(200);
      expect(active.body.job && active.body.job.id).toBe(body.jobId);
      release();
      await finish(body.jobId);
      const after = await request(serverFor(app)).get('/api/claims/active').set('Authorization', auth()).expect(200);
      expect(after.body.job).toBeNull();
    });
  });

  test('nine loose receipts import as nine expenses with lines, not zero', async () => {
    const zip = makeZip(Array.from({ length: 9 }, (_, i) => ({ name: `r${i}.jpg`, data: jpegBytes(10 + i) })));
    let i = 0;
    parser.parseReceiptImage.mockImplementation(async () => { const n = i++; return one({ merchant: `Shop ${n}`, date: '2026-08-24', currency: 'SGD', total: 10 + n, category: 'Meals' }); });
    const { body } = await start({ archives: [{ name: 'c.zip', data: b64(zip) }] }).expect(202);
    const done = await finish(body.jobId);
    expect(done.stage).toBe('done');
    expect(done.result.created).toHaveLength(9);
    const rows = rowsOf(done.result.groupId);
    expect(rows).toHaveLength(9);
    expect(rows.every(r => r.source === 'import' && r.status === 'review-needed' && r.lines.length === 1)).toBe(true);
    expect(rows.find(r => r.merchant === 'Shop 3').lines[0]).toMatchObject({ category: 'Meals', amount: 13 });
  });

  test('a PDF inside the archive goes through the document reader', async () => {
    const pdfPages = require('../pdf/pages');
    jest.spyOn(pdfPages, 'extractPages').mockResolvedValue({ pages: ['text'], numPages: 1, hasText: true, textPageCount: 1 });
    parser.parseReceiptText.mockResolvedValue({ split: false, receipts: [{ merchant: 'Agoda', date: '2026-08-17', currency: 'SGD', total: 1443.21, category: 'Lodging', confidence: 'high', lineItems: [] }] });
    const zip = makeZip([{ name: 'hotel.pdf', data: Buffer.from('%PDF-1.4 fake') }]);
    const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
    const rows = rowsOf(done.result.groupId);
    expect(rows).toHaveLength(1);
    expect(rows[0].merchant).toBe('Agoda');
    expect(rows[0].total).toBe(1443.21);
  });

  describe('duplicates', () => {
    test('the same receipt twice in one archive: the second is marked, not dropped', async () => {
      const same = jpegBytes(7);
      const zip = makeZip([{ name: 'a.jpg', data: same }, { name: 'copy-of-a.jpg', data: same }]);
      parser.parseReceiptImage.mockResolvedValue(one({ merchant: 'Grab', date: '2026-08-24', currency: 'SGD', total: 18.4 }));
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      const rows = rowsOf(done.result.groupId);
      expect(rows).toHaveLength(2);
      const dup = rows.find(r => r.status === 'duplicate');
      const orig = rows.find(r => r.status !== 'duplicate');
      expect(dup.duplicateOf).toBe(orig.id);
      expect(done.result.summary.duplicates).toBe(1);
    });

    test('the duplicate points at the original file rather than storing a second copy', async () => {
      const same = jpegBytes(8);
      const zip = makeZip([{ name: 'a.jpg', data: same }, { name: 'b.jpg', data: same }]);
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      const files = new Set(rowsOf(done.result.groupId).map(r => r.receipt.file));
      expect(files.size).toBe(1);
      expect(receiptStore.forUser(testUser.id).exists([...files][0])).toBe(true);
    });

    test('re-importing the whole archive marks every receipt as already held', async () => {
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(20) }, { name: 'b.jpg', data: jpegBytes(21) }]);
      const first = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      expect(first.result.summary.duplicates).toBe(0);
      const second = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      expect(second.result.summary.duplicates).toBe(2);
      expect(rowsOf(first.result.groupId).every(r => r.status === 'review-needed')).toBe(true);
    });

    test('matching merchant, date and amount is only flagged', async () => {
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(30) }, { name: 'b.jpg', data: jpegBytes(31) }]);
      parser.parseReceiptImage.mockResolvedValue(one({ merchant: 'Grab', date: '2026-08-24', currency: 'SGD', total: 18.4 }));
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      const rows = rowsOf(done.result.groupId);
      expect(rows.every(r => r.status === 'review-needed')).toBe(true);
      expect(done.result.summary.suspectedDuplicates).toBe(1);
      expect(rows.some(r => /Possible duplicate/.test(r.errorMsg || ''))).toBe(true);
    });

    test('two different receipts are left alone', async () => {
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(40) }, { name: 'b.jpg', data: jpegBytes(41) }]);
      let i = 0;
      parser.parseReceiptImage.mockImplementation(async () => { const n = i++; return one({ merchant: `Shop ${n}`, date: '2026-08-24', currency: 'SGD', total: 10 + n }); });
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      expect(done.result.summary.duplicates).toBe(0);
      expect(done.result.summary.suspectedDuplicates).toBe(0);
    });
  });

  describe('DELETE /group/:groupId', () => {
    test('removes every expense from the import', async () => {
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(50) }, { name: 'b.jpg', data: jpegBytes(51) }]);
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      const res = await request(serverFor(app)).delete(`/api/claims/group/${done.result.groupId}`).set('Authorization', auth()).expect(200);
      expect(res.body.removed).toBe(2);
      expect(rowsOf(done.result.groupId)).toHaveLength(0);
    });

    test('a shared file survives until the last expense referencing it is gone', async () => {
      const same = jpegBytes(60);
      const zip = makeZip([{ name: 'a.jpg', data: same }, { name: 'b.jpg', data: same }]);
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      const rows = rowsOf(done.result.groupId);
      const file = rows[0].receipt.file;
      store.deleteExpense(rows[1].id);
      expect(store.countExpensesForFile(testUser.id, file)).toBe(1);
      expect(receiptStore.forUser(testUser.id).exists(file)).toBe(true);
      await request(serverFor(app)).delete(`/api/claims/group/${done.result.groupId}`).set('Authorization', auth()).expect(200);
      expect(receiptStore.forUser(testUser.id).exists(file)).toBe(false);
    });

    test('404s for an import that is not mine', async () => {
      const other = await users.createUser({ email: `z${Date.now()}@solv.sg`, password: 'password123', companyId: testUser.companyId });
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(70) }]);
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      await request(serverFor(app)).delete(`/api/claims/group/${done.result.groupId}`).set('Authorization', auth(other)).expect(404);
      expect(rowsOf(done.result.groupId)).toHaveLength(1);
    });
  });

  describe('a claim form and its receipts', () => {
    test('matched lines carry the claimant figures, and the discrepancy is recorded', async () => {
      const form = await makeForm([{ no: 1, date: '2026-08-24', description: 'Taxi to client', amount: 18.4 }]);
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(80) }]);
      parser.parseReceiptImage.mockResolvedValue(one({ merchant: 'Grab', date: '2026-08-24', currency: 'SGD', total: 23.8 }));
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }], forms: [{ name: 'f.xlsx', data: b64(form) }] })).body.jobId);
      const rows = rowsOf(done.result.groupId);
      expect(rows).toHaveLength(1);
      expect(rows[0].total).toBe(18.4);
      expect(rows[0].lines[0].amount).toBe(18.4);
      expect(rows[0].errorMsg).toMatch(/receipt says/);
      expect(done.result.discrepancies).toHaveLength(1);
    });

    test('a claim line with no receipt still becomes an expense somebody has to resolve', async () => {
      const form = await makeForm([{ no: 1, date: '2026-08-24', description: 'Taxi', amount: 18.4 }]);
      const done = await finish((await start({ forms: [{ name: 'f.xlsx', data: b64(form) }] })).body.jobId);
      const rows = store.listExpenses({ userId: testUser.id });
      expect(rows).toHaveLength(1);
      expect(rows[0].receiptId).toBeNull();
      expect(rows[0].errorMsg).toMatch(/No receipt found/);
      expect(done.result.missingReceipts).toHaveLength(1);
    });
  });

  describe('a photo and an archive read as an upload is', () => {
    test('a photo of two receipts in the archive becomes two records sharing it, as an upload does', async () => {
      // Photos went five to a call through the batch reader, which reads one
      // receipt per image: the second receipt was lost.
      parser.parseReceiptImage.mockResolvedValue({ split: true, receipts: [
        { merchant: 'Grab', date: '2026-08-24', currency: 'SGD', total: 18.4, box: [0, 0, 1000, 480] },
        { merchant: 'Gojek', date: '2026-08-25', currency: 'SGD', total: 9.6, box: [0, 520, 1000, 1000] },
      ] });
      const zip = makeZip([{ name: 'two.jpg', data: jpegBytes(90) }]);
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      const rows = rowsOf(done.result.groupId);
      expect(rows.map(r => r.merchant).sort()).toEqual(['Gojek', 'Grab']);
      expect(new Set(rows.map(r => r.receipt.file)).size).toBe(1);
      expect(rows.every(r => Array.isArray(r.box))).toBe(true);
    });

    test('two archives with the same name keep their own files', async () => {
      const first = makeZip([{ name: 'a.jpg', data: jpegBytes(91) }]);
      const second = makeZip([{ name: 'a.jpg', data: jpegBytes(92) }]);
      const done = await finish((await start({ archives: [{ name: 'receipts.zip', data: b64(first) }, { name: 'receipts.zip', data: b64(second) }] })).body.jobId);
      const rows = rowsOf(done.result.groupId);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map(r => r.receipt.file)).size).toBe(2);
    });
  });

  describe('finding an import again, and where it goes', () => {
    test('GET /latest returns the finished import, until it is undone', async () => {
      const empty = await request(serverFor(app)).get('/api/claims/latest').set('Authorization', auth()).expect(200);
      expect(empty.body.job).toBeNull();
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(93) }]);
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      const latest = await request(serverFor(app)).get('/api/claims/latest').set('Authorization', auth()).expect(200);
      expect(latest.body.job).toMatchObject({ id: done.id, stage: 'done' });
      expect(latest.body.job.result.groupId).toBe(done.result.groupId);
      await request(serverFor(app)).delete(`/api/claims/group/${done.result.groupId}`).set('Authorization', auth()).expect(200);
      const after = await request(serverFor(app)).get('/api/claims/latest').set('Authorization', auth()).expect(200);
      expect(after.body.job).toBeNull();
    });

    test('an import started from a case goes into that case', async () => {
      const reports = require('../store/reports');
      const mine = reports.createReport({ companyId: testUser.companyId, userId: testUser.id, kind: 'case', title: 'Trip to KL' });
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(94) }, { name: 'b.jpg', data: jpegBytes(95) }]);
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }], reportId: mine.id })).body.jobId);
      expect(done.result).toMatchObject({ caseId: mine.id, caseIsNew: false, inCase: 2 });
      expect(reports.getReport(mine.id).expenses).toHaveLength(2);
    });

    test("an import cannot be started into someone else's case", async () => {
      const reports = require('../store/reports');
      const other = await users.createUser({ email: `k${Date.now()}@solv.sg`, password: 'password123', companyId: testUser.companyId });
      const theirs = reports.createReport({ companyId: testUser.companyId, userId: other.id, kind: 'case', title: 'Theirs' });
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(96) }]);
      await start({ archives: [{ name: 'c.zip', data: b64(zip) }], reportId: theirs.id }).expect(403);
    });

    test('a label or a file name that is not text is refused', async () => {
      const zip = b64(makeZip([{ name: 'a.jpg', data: jpegBytes(97) }]));
      await start({ archives: [{ name: 'c.zip', data: zip }], label: { evil: true } }).expect(400);
      await start({ archives: [{ name: ['c.zip'], data: zip }] }).expect(400);
    });

    test('stopping an import that has finished leaves it finished', async () => {
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(98) }]);
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      const res = await request(serverFor(app)).delete(`/api/claims/import/${done.id}`).set('Authorization', auth()).expect(200);
      expect(res.body.stage).toBe('done');
    });
  });
});
