jest.mock('./receipt-parser', () => ({ parseReceiptImage: jest.fn(), parseReceiptText: jest.fn(), parseReceiptPages: jest.fn() }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 1, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'frankfurter', fetchedAt: 'x' }) }));

// Reads a restart interrupted: read again from the stored file, or released.
describe('receipts/recover', () => {
  let store, users, parser, recover, receiptStore, u;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    store = require('../store/expenses'); users = require('../store/users'); parser = require('./receipt-parser');
    recover = require('./recover'); receiptStore = require('./receipt-store');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
    parser.parseReceiptImage.mockReset();
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Grab', date: '2026-09-01', total: 18.4, currency: 'SGD', category: 'Meals', confidence: 'high', lineItems: [] }] });
  });
  const stuck = (id) => {
    const name = receiptStore.forUser(u.id).save(id, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
    const r = store.createReceipt({ id, companyId: u.companyId, userId: u.id, file: name, mime: 'image/jpeg', sha256: id });
    return { r, e: store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, status: 'reading' }) };
  };

  test('a receipt whose first read never finished is read again from its file', async () => {
    const { e } = stuck('rec1');
    const out = await recover.recoverStuckReads({ before: new Date(Date.now() + 1000).toISOString() });
    expect(out).toEqual({ reread: 1, released: 0 });
    expect(store.getExpense(e.id)).toMatchObject({ status: 'review-needed', merchant: 'Grab' });
  });

  test('split parts and missing files are released with a note, and a read under way now is left alone', async () => {
    const { r, e } = stuck('rec2');
    const part = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, status: 'reading', page: 2 });
    const gone = store.createExpense({ companyId: u.companyId, userId: u.id, status: 'reading' });
    const before = new Date(Date.now() + 1000).toISOString();
    await new Promise(res => setTimeout(res, 1100));
    const fresh = store.createExpense({ companyId: u.companyId, userId: u.id, status: 'reading' });
    const out = await recover.recoverStuckReads({ before });
    expect(out).toEqual({ reread: 0, released: 3 });
    for (const id of [e.id, part.id, gone.id]) expect(store.getExpense(id)).toMatchObject({ status: 'review-needed', errorMsg: expect.stringMatching(/interrupted/) });
    expect(store.getExpense(fresh.id).status).toBe('reading');
    expect(parser.parseReceiptImage).not.toHaveBeenCalled();
  });
});
