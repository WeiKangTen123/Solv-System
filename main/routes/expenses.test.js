const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

// The reader is mocked one level down, so the real read pipeline runs against
// this test's own database rather than a stale module instance.
jest.mock('../utils/receipt-parser', () => ({
  parseReceiptImage: jest.fn().mockResolvedValue(null), parseReceiptText: jest.fn().mockResolvedValue(null), parseReceiptPages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/pdf-render', () => ({ renderPdfPages: jest.fn().mockResolvedValue(null) }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.0134, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: 'x' }) }));

describe('routes/expenses', () => {
  let app, users, store, admin, emp, mgr, fin, tokens, parser;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users'); store = require('../store/expenses'); parser = require('../utils/receipt-parser');
    parser.parseReceiptImage.mockReset(); parser.parseReceiptImage.mockResolvedValue(null);
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    mgr = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: admin.companyId, role: 'manager' });
    fin = await users.createUser({ email: 'f@solv.sg', password: 'password123', companyId: admin.companyId, role: 'finance' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, managerId: mgr.id });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, mgr, fin, emp].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/expenses', require('./expenses'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const seed = (owner, extra = {}) => {
    const r = store.createReceipt({ companyId: owner.companyId, userId: owner.id, file: 'r.jpg', mime: 'image/jpeg', sha256: `h${Math.random()}` });
    return store.createExpense({ companyId: owner.companyId, userId: owner.id, receiptId: r.id, status: 'review-needed', merchant: 'Courtyard', currency: 'INR', total: 100, receiptDate: '2026-09-04',
      lines: [{ category: 'Lodging', amount: 100 }], ...extra });
  };

  test('an employee lists and reads only their own; a manager sees a direct report; finance sees all', async () => {
    const mine = seed(emp); const theirs = seed(admin);
    const list = await request(serverFor(app)).get('/api/expenses').set(as(emp)).expect(200);
    expect(list.body.expenses.map(e => e.id)).toEqual([mine.id]);
    await request(serverFor(app)).get(`/api/expenses/${theirs.id}`).set(as(emp)).expect(404);
    await request(serverFor(app)).get(`/api/expenses/${mine.id}`).set(as(mgr)).expect(200);
    await request(serverFor(app)).get(`/api/expenses/${theirs.id}`).set(as(mgr)).expect(404);
    const all = await request(serverFor(app)).get('/api/expenses?all=1').set(as(fin)).expect(200);
    expect(all.body.expenses).toHaveLength(2);
    const detail = await request(serverFor(app)).get(`/api/expenses/${mine.id}`).set(as(emp)).expect(200);
    expect(detail.body.expense.lines).toHaveLength(1);
    expect(detail.body.imageToken).toBeTruthy();
  });

  test('editing fields; a new total resizes a single line; a bad currency is refused', async () => {
    const e = seed(emp);
    const r = await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ purpose: 'Client site visit', total: 120.5, merchant: 'Courtyard Pune' }).expect(200);
    expect(r.body.expense.purpose).toBe('Client site visit');
    expect(r.body.expense.lines[0].amount).toBe(120.5);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ currency: 'rupees' }).expect(400);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(admin)).send({ purpose: 'x' }).expect(200);   // admin may edit
  });

  test('lines must reconcile; a good split is stored with on-behalf', async () => {
    const e = seed(emp);
    await request(serverFor(app)).put(`/api/expenses/${e.id}/lines`).set(as(emp)).send({ lines: [{ category: 'Lodging', amount: 60 }, { category: 'Meals', amount: 30 }] }).expect(400);
    const ok = await request(serverFor(app)).put(`/api/expenses/${e.id}/lines`).set(as(emp))
      .send({ lines: [{ category: 'Lodging', amount: 60, onBehalfOf: 'Tan Suan Kuan' }, { category: 'Meals', amount: 40 }] }).expect(200);
    expect(ok.body.expense.lines.map(l => l.amount)).toEqual([60, 40]);
    expect(ok.body.expense.lines[0].onBehalfOf).toBe('Tan Suan Kuan');
  });

  test('marking reviewed needs a merchant, date, currency, total and reconciled lines', async () => {
    const e = seed(emp, { merchant: null });
    const bad = await request(serverFor(app)).patch(`/api/expenses/${e.id}/status`).set(as(emp)).send({ status: 'reviewed' }).expect(400);
    expect(bad.body.error).toMatch(/merchant/i);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ merchant: 'Courtyard' }).expect(200);
    const ok = await request(serverFor(app)).patch(`/api/expenses/${e.id}/status`).set(as(emp)).send({ status: 'reviewed' }).expect(200);
    expect(ok.body.expense.status).toBe('reviewed');
    await request(serverFor(app)).patch(`/api/expenses/${e.id}/status`).set(as(emp)).send({ status: 'posted' }).expect(400);
  });

  test('re-read applies the reader result to this expense only', async () => {
    const files = require('../utils/receipt-store').forUser(emp.id);
    const name = files.save('rr1', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
    const rcpt = store.createReceipt({ id: 'rr1', companyId: emp.companyId, userId: emp.id, file: name, mime: 'image/jpeg', sha256: 'rr' });
    const e = store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: rcpt.id, status: 'review-needed', merchant: 'Courtyard', currency: 'INR', total: 100, receiptDate: '2026-09-04', lines: [{ category: 'Lodging', amount: 100 }] });
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'JW Marriott', date: '2026-09-01', currency: 'INR', total: 44309, category: 'Lodging', confidence: 'high', lineItems: [] }] });
    const r = await request(serverFor(app)).post(`/api/expenses/${e.id}/reread`).set(as(emp)).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.expense.merchant).toBe('JW Marriott');
    expect(r.body.expense.lines).toEqual([expect.objectContaining({ amount: 44309 })]);
    parser.parseReceiptImage.mockResolvedValue(null);
    const miss = await request(serverFor(app)).post(`/api/expenses/${e.id}/reread`).set(as(emp)).expect(200);
    expect(miss.body.ok).toBe(false);
  });

  test('group lists siblings from one file and merge collapses them', async () => {
    const r = store.createReceipt({ companyId: emp.companyId, userId: emp.id, file: 'two.jpg', mime: 'image/jpeg', sha256: 'two' });
    const a = store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: r.id, status: 'review-needed', merchant: 'A', total: 5, box: [0, 0, 500, 1000] });
    const b = store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: r.id, status: 'review-needed', merchant: 'B', total: 7, box: [500, 0, 1000, 1000] });
    const g = await request(serverFor(app)).get(`/api/expenses/${a.id}/group`).set(as(emp)).expect(200);
    expect(g.body.total).toBe(2);
    expect(g.body.siblings.map(s => s.id).sort()).toEqual([a.id, b.id].sort());
    await request(serverFor(app)).post(`/api/expenses/${a.id}/merge`).set(as(emp)).expect(200);
    expect(store.getExpense(b.id)).toBeNull();
    expect(store.getExpense(a.id).box).toBeNull();
  });

  test('a foreign expense carries a base total, can be refreshed, and can be overridden with a reason', async () => {
    const e = seed(emp, { currency: 'INR', total: 100, lines: [{ category: 'Meals', amount: 100 }] });
    let r = await request(serverFor(app)).post(`/api/expenses/${e.id}/fx`).set(as(emp)).expect(200);
    expect(r.body.expense.baseTotal).toBe(1.34);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}/fx`).set(as(emp)).send({ rate: 0.02 }).expect(400);
    r = await request(serverFor(app)).patch(`/api/expenses/${e.id}/fx`).set(as(emp)).send({ rate: 0.02, reason: 'card statement' }).expect(200);
    expect(r.body.expense.lines[0]).toMatchObject({ fxRate: 0.02, fxSource: 'manual', baseAmount: 2 });
    r = await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ total: 200 }).expect(200);
    expect(r.body.expense.lines[0]).toMatchObject({ fxRate: 0.02, baseAmount: 4 });   // an override survives an edit
  });

  test('delete removes the expense and the file once nothing references it', async () => {
    const receiptStore = require('../utils/receipt-store');
    const files = receiptStore.forUser(emp.id);
    const name = files.save('del1', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    const r = store.createReceipt({ id: 'del1', companyId: emp.companyId, userId: emp.id, file: name, mime: 'image/jpeg', sha256: 'del' });
    const e = store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: r.id, status: 'review-needed', total: 1 });
    await request(serverFor(app)).delete(`/api/expenses/${e.id}`).set(as(admin)).expect(200);
    expect(store.getExpense(e.id)).toBeNull();
    expect(files.exists(name)).toBe(false);
    expect(store.getReceipt(r.id)).toBeNull();
  });
});
