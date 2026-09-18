const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');
const zlib    = require('zlib');
const ExcelJS = require('exceljs');

// The model is mocked throughout: what is under test is the route and the
// records it writes, not the vision read.
jest.mock('../utils/receipt-parser', () => ({
  parseReceiptBatch: jest.fn(async (userId, images) => images.map(() => null)),
  parseReceiptImage: jest.fn().mockResolvedValue(null),
  parseReceiptText:  jest.fn().mockResolvedValue(null),
  parseReceiptPages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/pdf-render', () => ({ renderPdfPages: jest.fn().mockResolvedValue(null) }));
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

describe('routes/claims', () => {
  let app, users, jwtSecret, testUser, store, receiptStore, claimImport, parser;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    store = require('../store/expenses');
    receiptStore = require('../utils/receipt-store');
    claimImport = require('../claims/claim-import');
    claimImport._reset();
    require('../claims/claim-worker')._reset();
    parser = require('../utils/receipt-parser');
    parser.parseReceiptBatch.mockReset();
    parser.parseReceiptBatch.mockImplementation(async (userId, images) => images.map(() => null));
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
      parser.parseReceiptBatch.mockImplementationOnce(async (userId, images) => { await holdOpen; return images.map(() => null); });
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
    parser.parseReceiptBatch.mockImplementation(async (userId, images) =>
      images.map((_, i) => ({ merchant: `Shop ${i}`, date: '2026-08-24', currency: 'SGD', total: 10 + i, category: 'Meals' })));
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
    const pdfPages = require('../utils/pdf-pages');
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
      parser.parseReceiptBatch.mockImplementation(async (userId, images) => images.map(() => ({ merchant: 'Grab', date: '2026-08-24', currency: 'SGD', total: 18.4 })));
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
      parser.parseReceiptBatch.mockImplementation(async (userId, images) => images.map(() => ({ merchant: 'Grab', date: '2026-08-24', currency: 'SGD', total: 18.4 })));
      const done = await finish((await start({ archives: [{ name: 'c.zip', data: b64(zip) }] })).body.jobId);
      const rows = rowsOf(done.result.groupId);
      expect(rows.every(r => r.status === 'review-needed')).toBe(true);
      expect(done.result.summary.suspectedDuplicates).toBe(1);
      expect(rows.some(r => /Possible duplicate/.test(r.errorMsg || ''))).toBe(true);
    });

    test('two different receipts are left alone', async () => {
      const zip = makeZip([{ name: 'a.jpg', data: jpegBytes(40) }, { name: 'b.jpg', data: jpegBytes(41) }]);
      parser.parseReceiptBatch.mockImplementation(async (userId, images) => images.map((_, i) => ({ merchant: `Shop ${i}`, date: '2026-08-24', currency: 'SGD', total: 10 + i })));
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
      parser.parseReceiptBatch.mockImplementation(async (userId, images) => images.map(() => ({ merchant: 'Grab', date: '2026-08-24', currency: 'SGD', total: 23.8 })));
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
});
