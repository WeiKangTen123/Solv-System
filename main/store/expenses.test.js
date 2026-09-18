describe('store/expenses', () => {
  let store, users, u;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    store = require('./expenses');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
  });
  const rc = (extra = {}) => store.createReceipt({ companyId: u.companyId, userId: u.id, file: 'r.jpg', mime: 'image/jpeg', sizeBytes: 10, sha256: 'abc', ...extra });

  test('a receipt and an expense are created and read back in camelCase with dollars', () => {
    const r = rc();
    const e = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, merchant: 'Courtyard Pune', currency: 'INR', total: 88188.77, tax: 13452.52 });
    const back = store.getExpense(e.id);
    expect(back.status).toBe('reading');
    expect(back.total).toBe(88188.77);
    expect(back.tax).toBe(13452.52);
    expect(back.receipt).toMatchObject({ id: r.id, file: 'r.jpg', mime: 'image/jpeg' });
    expect(back.lines).toEqual([]);
    expect(store.findReceiptByHash(u.companyId, 'abc').id).toBe(r.id);
    expect(store.findReceiptByHash(u.companyId, 'nope')).toBeNull();
  });

  test('lines must reconcile to the total, to the cent', () => {
    const e = store.createExpense({ companyId: u.companyId, userId: u.id, currency: 'INR', total: 100, status: 'review-needed' });
    expect(() => store.replaceLines(e.id, [{ category: 'Lodging', amount: 60 }, { category: 'Meals', amount: 39.99 }])).toThrow(/99\.99.*100\.00/);
    store.replaceLines(e.id, [{ category: 'Lodging', amount: 60, onBehalfOf: 'Tan Suan Kuan' }, { category: 'Meals', amount: 40 }]);
    const lines = store.getExpense(e.id).lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ category: 'Lodging', amount: 60, onBehalfOf: 'Tan Suan Kuan', currency: 'INR', sortOrder: 0 });
    expect(lines[1].amount).toBe(40);
  });

  test('update leaves undefined alone, clears null, and bumps updatedAt', () => {
    const e = store.createExpense({ companyId: u.companyId, userId: u.id, merchant: 'A', purpose: 'x', total: 5 });
    const upd = store.updateExpense(e.id, { merchant: undefined, purpose: null, total: 6 });
    expect(upd.merchant).toBe('A');
    expect(upd.purpose).toBeNull();
    expect(upd.total).toBe(6);
    expect(upd.updatedAt).toBeTruthy();
  });

  test('listExpenses filters by user, status, unfiled and date range', () => {
    const other = { companyId: u.companyId, userId: u.id };
    store.createExpense({ ...other, receiptDate: '2026-09-01', status: 'review-needed', total: 1 });
    store.createExpense({ ...other, receiptDate: '2026-09-10', status: 'reviewed', total: 2 });
    expect(store.listExpenses({ userId: u.id })).toHaveLength(2);
    expect(store.listExpenses({ userId: u.id, status: 'reviewed' })).toHaveLength(1);
    expect(store.listExpenses({ userId: u.id, from: '2026-09-05' })).toHaveLength(1);
    expect(store.listExpenses({ userId: u.id, unfiled: true })).toHaveLength(2);
  });

  test('deleting the last expense on a receipt reports the receipt is unreferenced', () => {
    const r = rc();
    const a = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, total: 1 });
    const b = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, total: 2 });
    store.deleteExpense(a.id);
    expect(store.countExpensesForReceipt(r.id)).toBe(1);
    store.deleteExpense(b.id);
    expect(store.countExpensesForReceipt(r.id)).toBe(0);
    store.deleteReceipt(r.id);
    expect(store.getReceipt(r.id)).toBeNull();
  });

  test('dedupView speaks the shape intake/dedup expects', () => {
    const r = rc({ sha256: 'h1' });
    store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, merchant: 'Grab', receiptDate: '2026-09-01', total: 18.4, status: 'review-needed' });
    const view = store.dedupView(u.companyId);
    expect(view.findByReceiptHash('h1')).toMatchObject({ vendorName: 'Grab', totalAmount: 18.4 });
    expect(view.getAll()[0]).toMatchObject({ vendorName: 'Grab', invoiceDate: '2026-09-01', totalAmount: 18.4, status: 'review-needed' });
  });
});
