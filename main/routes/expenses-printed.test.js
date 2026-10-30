const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

// A receipt kept as printed (receipts/printed.js), through the routes: the
// record is typed over with PUT /printed, the lines follow it and cannot be
// typed, the total stays the record's, and every change is in the log.
jest.mock('../receipts/receipt-parser', () => ({
  parseReceiptImage: jest.fn().mockResolvedValue(null), parseReceiptText: jest.fn().mockResolvedValue(null), parseReceiptPages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../pdf/render', () => ({ renderPdfPages: jest.fn().mockResolvedValue(null) }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.3, rateDate: '2026-10-08', providerDate: '2026-10-08', source: 'frankfurter', fetchedAt: 'x' }) }));

const row = (kind, label, amount, x = {}) => ({ kind, label, amount, qty: null, unitPrice: null, rate: null, included: false, worked: false,
  category: null, onBehalfOf: null, taxRate: null, on: null, ...x });
const nasiKandar = () => ({ v: 1, subtotal: 23.9, total: 27.85, rows: [
  row('item', 'Nasi Kandar Ayam Goreng', 14.5, { category: 'Meals' }),
  row('item', 'Roti Canai', 3, { qty: 2, unitPrice: 1.5, category: 'Meals' }),
  row('item', 'Teh Tarik', 6.4, { qty: 2, unitPrice: 3.2, category: 'Meals' }),
  row('charge', 'Service Charge', 2.39, { rate: 10 }),
  row('tax', 'SST', 1.58, { rate: 6 }),
  row('rounding', 'Rounding Adj', -0.02),
] });

describe('routes/expenses — a receipt kept as printed', () => {
  let app, users, store, admin, emp, other, tokens;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/expenses', require('./expenses'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const api = () => request(serverFor(app));
  // A receipt read with its record, as the reader leaves it.
  const seed = (extra = {}) => {
    const printed = require('../receipts/printed');
    const record = printed.validate(nasiKandar());
    const r = store.createReceipt({ companyId: emp.companyId, userId: emp.id, file: 'r.jpg', mime: 'image/jpeg', sha256: `h${Math.random()}` });
    const e = store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: r.id, status: 'review-needed', merchant: 'Restoran Sri Melaka',
      currency: 'MYR', total: 27.85, tax: 1.58, subTotal: 23.9, receiptDate: '2026-10-08', category: 'Meals', printed: record,
      lines: printed.claimLines(record, 'Meals').map(l => ({ ...l, currency: 'MYR' })), ...extra });
    return store.updateExpense(e.id, { aiRead: { total: 27.85, tax: 1.58, printed: record } });
  };

  test('GET gives the record, the reader\'s copy of it, and each line\'s taxes', async () => {
    const e = seed();
    const r = await api().get(`/api/expenses/${e.id}`).set(as(emp)).expect(200);
    expect(r.body.expense.printed.rows).toHaveLength(6);
    expect(r.body.expense.aiRead.printed.rows[4]).toMatchObject({ kind: 'tax', label: 'SST', rate: 6, amount: 1.58 });
    expect(r.body.expense.lines).toEqual([expect.objectContaining({ category: 'Meals', amount: 27.85, taxes: [{ label: 'SST', rate: 6, amount: 1.58, included: false, gross: 27.87 }] })]);
  });

  test('PUT /printed saves the record, sets the total, tax and subtotal from it, makes the lines and logs each row', async () => {
    const e = seed();
    const next = nasiKandar();
    next.rows[2].onBehalfOf = 'Jane Tan';
    next.rows[4].amount = 1.6;
    next.rows.splice(3, 0, row('item', 'Teh O Ais', 2.5, { category: 'Meals' }));
    next.total = 30.37; next.subtotal = 26.4;
    const r = await api().put(`/api/expenses/${e.id}/printed`).set(as(emp)).send({ printed: next }).expect(200);
    expect(r.body.expense).toMatchObject({ total: 30.37, tax: 1.6, subTotal: 26.4 });
    expect(r.body.expense.printed.rows).toHaveLength(7);
    expect(r.body.expense.lines.map(l => [l.category, l.onBehalfOf, l.amount])).toEqual([['Meals', null, 23], ['Meals', 'Jane Tan', 7.37]]);
    expect(r.body.expense.lines.reduce((s, l) => s + l.taxes[0].amount, 0)).toBeCloseTo(1.6, 10);
    expect(r.body.expense.lines.every(l => l.baseAmount > 0)).toBe(true);   // priced again
    expect(r.body).toMatchObject({ canEditDetails: true, isOwner: true });
    const log = await api().get(`/api/expenses/${e.id}/changes`).set(as(emp)).expect(200);
    expect(log.body.changes.find(c => c.field === 'printed')).toMatchObject({ label: 'As printed', oldValue: null,
      newValue: 'Teh Tarik now for Jane Tan · Added Teh O Ais 2.50 · SST 6% 1.58 → 1.60' });
    expect(log.body.changes.find(c => c.field === 'total')).toMatchObject({ oldValue: '27.85', newValue: '30.37' });
    expect(log.body.changes.find(c => c.field === 'tax')).toMatchObject({ oldValue: '1.58', newValue: '1.60' });
  });

  test('a record whose tax rows are unchanged keeps the tax it was read with', async () => {
    const e = seed({ tax: 1.57 });
    const next = nasiKandar(); next.rows[0].label = 'Nasi Kandar Ayam';
    const r = await api().put(`/api/expenses/${e.id}/printed`).set(as(emp)).send({ printed: next }).expect(200);
    expect(r.body.expense.tax).toBe(1.57);
  });

  test('a record that does not add up is kept as sent; the lines still come to the total', async () => {
    const e = seed();
    const next = nasiKandar(); next.rows = next.rows.filter(x => x.label !== 'Teh Tarik');
    const r = await api().put(`/api/expenses/${e.id}/printed`).set(as(emp)).send({ printed: next }).expect(200);
    expect(r.body.expense.total).toBe(27.85);
    expect(r.body.expense.lines.reduce((s, l) => s + l.amount * 100, 0)).toBe(2785);
    expect(r.body.expense.flags.map(f => f.code)).not.toContain('lines-off');
  });

  test('a record that is not one is refused with a sentence, and nothing changes', async () => {
    const e = seed();
    let r = await api().put(`/api/expenses/${e.id}/printed`).set(as(emp)).send({}).expect(400);
    expect(r.body.error).toMatch(/rows and its total/);
    r = await api().put(`/api/expenses/${e.id}/printed`).set(as(emp)).send({ printed: { rows: [row('fee', 'x', 1)], total: 1 } }).expect(400);
    expect(r.body.error).toMatch(/Row 1 must be an item/);
    r = await api().put(`/api/expenses/${e.id}/printed`).set(as(emp)).send({ printed: { rows: [row('item', 'Room', 'lots')], total: 1 } }).expect(400);
    expect(r.body.error).toMatch(/Row 1 \(Room\): the amount must be a number/);
    r = await api().put(`/api/expenses/${e.id}/printed`).set(as(emp)).send({ printed: { ...nasiKandar(), total: -3 } }).expect(400);
    expect(store.getExpense(e.id).printed.total).toBe(27.85);
  });

  test('who may: the owner and an admin of the company; a colleague does not see it; not while it is read, nor once in Xero', async () => {
    const e = seed();
    await api().put(`/api/expenses/${e.id}/printed`).set(as(other)).send({ printed: nasiKandar() }).expect(404);
    const byAdmin = await api().put(`/api/expenses/${e.id}/printed`).set(as(admin)).send({ printed: { ...nasiKandar(), total: 27.9 } }).expect(200);
    expect(byAdmin.body).toMatchObject({ isOwner: false, canEditDetails: true });
    const reading = seed({ status: 'reading' });
    await api().put(`/api/expenses/${reading.id}/printed`).set(as(emp)).send({ printed: nasiKandar() }).expect(409);
    const reports = require('../store/reports');
    const rep = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'KL' });
    const posted = seed();
    reports.addExpense(rep.id, posted.id);
    require('../db').prepare("UPDATE expense_reports SET status = 'claimed', xero_invoice_id = 'INV-1' WHERE id = ?").run(rep.id);
    const r = await api().put(`/api/expenses/${posted.id}/printed`).set(as(emp)).send({ printed: nasiKandar() }).expect(409);
    expect(r.body.error).toMatch(/posted to Xero/);
  });

  test('a per diem has no receipt to keep as printed', async () => {
    const e = store.createExpense({ companyId: emp.companyId, userId: emp.id, status: 'review-needed', source: 'per_diem', merchant: 'Per diem', currency: 'MYR', total: 100, receiptDate: '2026-10-08', lines: [{ category: 'Meals', amount: 100 }] });
    const r = await api().put(`/api/expenses/${e.id}/printed`).set(as(emp)).send({ printed: nasiKandar() }).expect(400);
    expect(r.body.error).toMatch(/no receipt to keep as printed/);
  });

  test('PUT /lines answers 409 on a receipt with a record, and still splits one without', async () => {
    const e = seed();
    const r = await api().put(`/api/expenses/${e.id}/lines`).set(as(emp)).send({ lines: [{ category: 'Meals', amount: 20 }, { category: 'Other', amount: 7.85 }] }).expect(409);
    expect(r.body.error).toBe('This receipt\'s lines come from its items; change the items instead.');
    const old = seed({ printed: null });
    await api().put(`/api/expenses/${old.id}/lines`).set(as(emp)).send({ lines: [{ category: 'Meals', amount: 20 }, { category: 'Other', amount: 7.85 }] }).expect(200);
  });

  test('PATCH total keeps the record\'s total the same, and the lines are made again from the rows', async () => {
    const e = seed();
    const r = await api().patch(`/api/expenses/${e.id}`).set(as(emp)).send({ total: 28 }).expect(200);
    expect(r.body.expense.total).toBe(28);
    expect(r.body.expense.printed.total).toBe(28);
    expect(r.body.expense.printed.rows).toHaveLength(6);
    expect(r.body.expense.lines).toEqual([expect.objectContaining({ amount: 28, taxes: [expect.objectContaining({ label: 'SST', amount: 1.58 })] })]);
    const s = await api().patch(`/api/expenses/${e.id}`).set(as(emp)).send({ subTotal: 24 }).expect(200);
    expect(s.body.expense.printed.subtotal).toBe(24);
  });

  test('the tax is the tax rows\': PATCH may send it unchanged, not changed', async () => {
    const e = seed();
    await api().patch(`/api/expenses/${e.id}`).set(as(emp)).send({ tax: 1.58, purpose: 'Team lunch' }).expect(200);
    const r = await api().patch(`/api/expenses/${e.id}`).set(as(emp)).send({ tax: 2 }).expect(409);
    expect(r.body.error).toMatch(/tax rows/);
    expect(store.getExpense(e.id).tax).toBe(1.58);
  });

  test('the categories are the items\': PATCH may send the category unchanged, not changed', async () => {
    const e = seed();
    await api().patch(`/api/expenses/${e.id}`).set(as(emp)).send({ category: 'Meals', purpose: 'Team lunch' }).expect(200);
    const r = await api().patch(`/api/expenses/${e.id}`).set(as(emp)).send({ category: 'Entertainment' }).expect(409);
    expect(r.body.error).toBe('This receipt\'s categories are its items\'; change those instead.');
    const after = store.getExpense(e.id);
    expect(after.category).toBe('Meals');
    expect(after.lines.map(l => l.category)).toEqual(['Meals']);
  });

  test('a rate typed for the receipt stays when the record changes, and goes with the currency', async () => {
    const e = seed();
    await api().patch(`/api/expenses/${e.id}/fx`).set(as(admin)).send({ rate: 0.31, reason: 'card statement' }).expect(200);
    const next = nasiKandar(); next.rows[0].amount = 15; next.total = 28.35;
    const r = await api().put(`/api/expenses/${e.id}/printed`).set(as(emp)).send({ printed: next }).expect(200);
    expect(r.body.expense.lines.every(l => l.fxRate === 0.31 && l.fxSource === 'manual')).toBe(true);
    const c = await api().patch(`/api/expenses/${e.id}`).set(as(emp)).send({ currency: 'SGD' }).expect(200);
    expect(c.body.expense.lines.every(l => l.fxSource !== 'manual' && l.currency === 'SGD')).toBe(true);
  });

  test('merging the parts of a photo drops the record: it is no longer one printed receipt', async () => {
    const a = seed({ box: [0, 0, 500, 1000] });
    store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: a.receiptId, status: 'review-needed', merchant: 'B', total: 7, box: [500, 0, 1000, 1000] });
    const r = await api().post(`/api/expenses/${a.id}/merge`).set(as(emp)).expect(200);
    expect(r.body.expense.printed).toBeNull();
    expect(r.body.expense.lines).toHaveLength(1);
    await api().put(`/api/expenses/${a.id}/lines`).set(as(emp)).send({ lines: [{ category: 'Meals', amount: 27.85 }] }).expect(200);
    const log = await api().get(`/api/expenses/${a.id}/changes`).set(as(emp)).expect(200);
    expect(log.body.changes.find(c => c.field === 'printed')).toMatchObject({ newValue: 'No longer kept as printed' });
  });
});
