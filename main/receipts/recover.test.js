jest.mock('./receipt-parser', () => ({ parseReceiptImage: jest.fn(), parseReceiptText: jest.fn(), parseReceiptPages: jest.fn() }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 1, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'frankfurter', fetchedAt: 'x' }) }));

// Reads a restart interrupted: the queue's own are left to it, a receipt from
// before the queue is queued again from its file, anything else is released.
describe('receipts/recover', () => {
  let store, users, parser, recover, receiptStore, readQueue, u;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    store = require('../store/expenses'); users = require('../store/users'); parser = require('./receipt-parser');
    recover = require('./recover'); receiptStore = require('./receipt-store'); readQueue = require('./read-queue');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
    parser.parseReceiptImage.mockReset();
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Grab', date: '2026-09-01', total: 18.4, currency: 'SGD', category: 'Meals', confidence: 'high', lineItems: [] }] });
  });
  afterEach(() => readQueue.stop());
  const stuck = (id) => {
    const name = receiptStore.forUser(u.id).save(id, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
    const r = store.createReceipt({ id, companyId: u.companyId, userId: u.id, file: name, mime: 'image/jpeg', sha256: id });
    return { r, e: store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, status: 'reading' }) };
  };
  const later = () => new Date(Date.now() + 1000).toISOString();

  test('a receipt from before the queue whose first read never finished is queued and read again from its file', async () => {
    const { r, e } = stuck('rec1');
    expect(recover.recoverStuckReads({ before: later() })).toEqual({ queued: 1, released: 0, owned: 0 });
    expect(readQueue.statesFor([r.id]).get(r.id)).toBeTruthy();
    await readQueue.drain();
    expect(store.getExpense(e.id)).toMatchObject({ status: 'review-needed', merchant: 'Grab' });
    expect(readQueue.statesFor([r.id]).get(r.id).state).toBe('done');
  });

  test('a receipt with a job is the queue\'s, and is left alone', () => {
    readQueue.stop();
    const { r, e } = stuck('rec3');
    readQueue.enqueue({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id });
    expect(recover.recoverStuckReads({ before: later() })).toEqual({ queued: 0, released: 0, owned: 1 });
    expect(store.getExpense(e.id).status).toBe('reading');
  });

  test('split parts and missing files are released with a note, and a read under way now is left alone', async () => {
    const { r, e } = stuck('rec2');
    const part = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, status: 'reading', page: 2 });
    const gone = store.createExpense({ companyId: u.companyId, userId: u.id, status: 'reading' });
    const before = later();
    const fresh = store.createExpense({ companyId: u.companyId, userId: u.id, status: 'reading' });
    // Made after the boot: dated past `before` directly, rather than waiting a
    // second of real time for the clock to get there.
    require('../db').prepare('UPDATE expenses SET created_at = ? WHERE id = ?').run(new Date(Date.now() + 2000).toISOString(), fresh.id);
    expect(recover.recoverStuckReads({ before })).toEqual({ queued: 0, released: 3, owned: 0 });
    for (const id of [e.id, part.id, gone.id]) expect(store.getExpense(id)).toMatchObject({ status: 'review-needed', errorMsg: expect.stringMatching(/interrupted/) });
    expect(store.getExpense(fresh.id).status).toBe('reading');
    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
  });

  test('a receipt whose file has gone is released rather than queued', () => {
    const { r, e } = stuck('rec4');
    receiptStore.forUser(u.id).remove(r.file);
    expect(recover.recoverStuckReads({ before: later() })).toEqual({ queued: 0, released: 1, owned: 0 });
    expect(store.getExpense(e.id).status).toBe('review-needed');
  });
});
