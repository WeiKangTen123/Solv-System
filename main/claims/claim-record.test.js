jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue(null) }));

// One record per claim line, against a real database.
describe('claims/claim-record', () => {
  let users, store, record, undo, reports, u, peer;
  const storeFile = jest.fn(async (uid, id) => `${id}.pdf`);
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports');
    record = require('./claim-record'); undo = require('./claim-undo');
    u = await users.createUser({ email: 'u@solv.sg', password: 'password123' });
    peer = await users.createUser({ email: 'p@solv.sg', password: 'password123', companyId: u.companyId });
    storeFile.mockClear(); storeFile.mockImplementation(async (uid, id) => `${id}.pdf`);
  });
  const pdf = Buffer.from('%PDF-1.4 several receipts');
  const part = (k, merchant, total) => ({ merchant, date: '2026-09-0' + (k + 1), total, currency: 'SGD', buffer: pdf, mime: 'application/pdf', file: 'r.pdf', readable: true, page: k + 1, part: k, fileKey: 'c.zip/r.pdf' });
  const row = (r) => ({ no: null, date: r.date, description: r.merchant, currency: 'SGD', amount: r.total });

  test('the parts of one PDF share its file, know their page, and are not duplicates of each other', async () => {
    const files = new Map();
    const a = await record.createClaimRecord({ userId: u.id, groupId: 'job-1', row: row(part(0, 'A', 10)), receipt: part(0, 'A', 10), store: storeFile, files });
    const b = await record.createClaimRecord({ userId: u.id, groupId: 'job-1', row: row(part(1, 'B', 20)), receipt: part(1, 'B', 20), store: storeFile, files });
    expect(storeFile).toHaveBeenCalledTimes(1);
    expect(a.receipt.file).toBe(b.receipt.file);
    expect([a.page, b.page]).toEqual([1, 2]);
    expect([a.status, b.status]).toEqual(['review-needed', 'review-needed']);
    expect([a.importId, b.importId]).toEqual(['job-1', 'job-1']);
  });

  test("a byte-identical copy of a colleague's receipt is a duplicate that keeps its own file", async () => {
    const theirs = await record.createClaimRecord({ userId: peer.id, groupId: 'job-p', row: row(part(0, 'A', 10)), receipt: { ...part(0, 'A', 10), fileKey: null, part: 0 }, store: storeFile });
    const mine = await record.createClaimRecord({ userId: u.id, groupId: 'job-u', row: row(part(0, 'A', 10)), receipt: { ...part(0, 'A', 10), fileKey: null, part: 0 }, store: storeFile });
    expect(mine.status).toBe('duplicate');
    expect(mine.duplicateOf).toBe(theirs.id);
    expect(storeFile).toHaveBeenCalledTimes(2);
    expect(storeFile.mock.calls[1][0]).toBe(u.id);
  });

  test('a file that could not be stored leaves no row behind to block the next upload of it', async () => {
    storeFile.mockRejectedValueOnce(new Error('disk full'));
    const r = await record.createClaimRecord({ userId: u.id, groupId: 'job-2', row: row(part(0, 'A', 10)), receipt: { ...part(0, 'A', 10), fileKey: null }, store: storeFile });
    expect(r.receiptId).toBeNull();
    expect(r.errorMsg).toMatch(/could not be kept/);
    expect(require('../db').prepare("SELECT COUNT(*) AS n FROM receipts WHERE file = 'pending'").get().n).toBe(0);
  });

  test('undoing an import removes every row it made, those with no receipt too, and its empty case', async () => {
    const withFile = await record.createClaimRecord({ userId: u.id, groupId: 'job-3', row: row(part(0, 'A', 10)), receipt: { ...part(0, 'A', 10), fileKey: null }, store: storeFile });
    const noFile = await record.createClaimRecord({ userId: u.id, groupId: 'job-3', row: { no: '2', date: '2026-09-03', description: 'Taxi', currency: 'SGD', amount: 12 }, receipt: null, store: storeFile });
    const c = reports.createReport({ companyId: u.companyId, userId: u.id, kind: 'case', title: 'Import' });
    reports.addExpense(c.id, withFile.id); reports.addExpense(c.id, noFile.id);
    const out = undo.undoImport(u.id, 'job-3');
    expect(out).toMatchObject({ found: 2, removed: 2, casesRemoved: 1 });
    expect(store.getExpense(noFile.id)).toBeNull();
    expect(reports.getReport(c.id)).toBeNull();
  });
});
