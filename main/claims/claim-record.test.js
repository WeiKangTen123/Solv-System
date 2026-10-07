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

  test('a later part saved first stores the file with its hash, and a re-import finds every part', async () => {
    // Parts are saved in matching order, so part 1 can come first. Only part 0
    // was hashed: the stored file had no hash, and nothing found it again.
    const first = new Map();
    const b = await record.createClaimRecord({ userId: u.id, groupId: 'job-5', row: row(part(1, 'B', 20)), receipt: part(1, 'B', 20), store: storeFile, files: first });
    const a = await record.createClaimRecord({ userId: u.id, groupId: 'job-5', row: row(part(0, 'A', 10)), receipt: part(0, 'A', 10), store: storeFile, files: first });
    expect(storeFile).toHaveBeenCalledTimes(1);
    expect(b.receipt.sha256).toBeTruthy();
    expect([a.status, b.status]).toEqual(['review-needed', 'review-needed']);

    const again = new Map();
    const a2 = await record.createClaimRecord({ userId: u.id, groupId: 'job-6', row: row(part(0, 'A', 10)), receipt: part(0, 'A', 10), store: storeFile, files: again });
    const b2 = await record.createClaimRecord({ userId: u.id, groupId: 'job-6', row: row(part(1, 'B', 20)), receipt: part(1, 'B', 20), store: storeFile, files: again });
    expect([a2.status, b2.status]).toEqual(['duplicate', 'duplicate']);
    expect(storeFile).toHaveBeenCalledTimes(1);          // the file is not stored twice
  });

  test('a duplicate of your own receipt adds nothing to your storage', async () => {
    const receipt = { ...part(0, 'A', 10), fileKey: null };
    await record.createClaimRecord({ userId: u.id, groupId: 'job-7', row: row(receipt), receipt, store: storeFile });
    const before = store.bytesStoredBy(u.id);
    const copy = await record.createClaimRecord({ userId: u.id, groupId: 'job-8', row: row(receipt), receipt, store: storeFile });
    expect(copy.status).toBe('duplicate');
    expect(store.bytesStoredBy(u.id)).toBe(before);
  });

  test('a currency typed as a symbol is stored as its code, and one that names none gives way to the receipt', async () => {
    const r1 = await record.createClaimRecord({ userId: u.id, groupId: 'job-9', row: { no: '1', date: '2026-09-01', description: 'Taxi', currency: 'S$', amount: 12 }, receipt: null, store: storeFile });
    expect(r1.currency).toBe('SGD');
    const receipt = { ...part(0, 'Grab', 40), currency: 'MYR', fileKey: null };
    const r2 = await record.createClaimRecord({ userId: u.id, groupId: 'job-9', row: { no: '2', date: receipt.date, description: 'Grab', currency: '$', amount: 40 }, receipt, store: storeFile });
    expect(r2.currency).toBe('MYR');
  });

  test("a claimed 0 is a blank, and the receipt's total stands", async () => {
    const receipt = { ...part(0, 'Hotel', 250), fileKey: null };
    const r = await record.createClaimRecord({ userId: u.id, groupId: 'job-10', row: { ...row(receipt), amount: 0 }, receipt, store: storeFile });
    expect(r.total).toBe(250);
    expect(r.lines[0].amount).toBe(250);
  });

  test("what the reader said about the whole file is on the record's note", async () => {
    const receipt = { ...part(0, 'A', 10), fileKey: null, notes: 'Only the first 20 of 35 pages were read; check the rest by hand.' };
    const r = await record.createClaimRecord({ userId: u.id, groupId: 'job-11', row: row(receipt), receipt, store: storeFile });
    expect(r.errorMsg).toMatch(/Only the first 20 of 35 pages/);
  });

  test('undo also removes the receipts the import stored but never made an expense for', async () => {
    const receiptStore = require('../receipts/receipt-store');
    const files = receiptStore.forUser(u.id);
    const left = store.createReceipt({ companyId: u.companyId, userId: u.id, file: 'pending', mime: 'image/jpeg', sizeBytes: 9, sha256: 'abc', source: 'import', groupId: 'job-12' });
    const stored = store.createReceipt({ companyId: u.companyId, userId: u.id, file: 'pending', mime: 'image/jpeg', sizeBytes: 9, source: 'import', groupId: 'job-12' });
    const name = await files.save(stored.id, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01]), 'image/jpeg');
    store.updateReceipt(stored.id, { file: name });
    await record.createClaimRecord({ userId: u.id, groupId: 'job-12', row: { no: '1', date: '2026-09-03', description: 'Taxi', currency: 'SGD', amount: 12 }, receipt: null, store: storeFile });

    const out = undo.undoImport(u.id, 'job-12');
    expect(out).toMatchObject({ found: 1, orphans: 2 });
    expect(store.getReceipt(left.id)).toBeNull();
    expect(store.getReceipt(stored.id)).toBeNull();
    expect(files.exists(name)).toBe(false);
  });

  test('undo leaves the case the import was started from, even emptied', async () => {
    const mine = reports.createReport({ companyId: u.companyId, userId: u.id, kind: 'case', title: 'Trip to KL' });
    await new Promise(r => setTimeout(r, 5));
    const r = await record.createClaimRecord({ userId: u.id, groupId: 'job-13', row: { no: '1', date: '2026-09-03', description: 'Taxi', currency: 'SGD', amount: 12 }, receipt: null, store: storeFile });
    reports.addExpense(mine.id, r.id);
    expect(undo.undoImport(u.id, 'job-13')).toMatchObject({ removed: 1, casesRemoved: 0 });
    expect(reports.getReport(mine.id)).toBeTruthy();
  });
});
