const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

// The reader is mocked one level down, so the real read pipeline runs against
// this test's own database rather than a stale module instance.
jest.mock('../receipts/receipt-parser', () => ({
  parseReceiptImage: jest.fn().mockResolvedValue(null), parseReceiptText: jest.fn().mockResolvedValue(null), parseReceiptPages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../pdf/render', () => ({ renderPdfPages: jest.fn().mockResolvedValue(null) }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.0134, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: 'x' }) }));

describe('routes/expenses', () => {
  let app, users, store, admin, emp, other, tokens, parser;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); parser = require('../receipts/receipt-parser');
    parser.parseReceiptImage.mockReset(); parser.parseReceiptImage.mockResolvedValue(null);
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/expenses', require('./expenses'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const seed = (owner, extra = {}) => {
    const r = store.createReceipt({ companyId: owner.companyId, userId: owner.id, file: 'r.jpg', mime: 'image/jpeg', sha256: `h${Math.random()}` });
    return store.createExpense({ companyId: owner.companyId, userId: owner.id, receiptId: r.id, status: 'review-needed', merchant: 'Courtyard', currency: 'INR', total: 100, receiptDate: '2026-09-04',
      lines: [{ category: 'Lodging', amount: 100 }], ...extra });
  };

  test('a user lists and reads only their own; an admin sees all, and only an admin', async () => {
    const mine = seed(emp); const theirs = seed(admin);
    const list = await request(serverFor(app)).get('/api/expenses').set(as(emp)).expect(200);
    expect(list.body.expenses.map(e => e.id)).toEqual([mine.id]);
    await request(serverFor(app)).get(`/api/expenses/${theirs.id}`).set(as(emp)).expect(404);
    await request(serverFor(app)).get(`/api/expenses/${mine.id}`).set(as(other)).expect(404);
    await request(serverFor(app)).get(`/api/expenses/${mine.id}`).set(as(admin)).expect(200);
    const all = await request(serverFor(app)).get('/api/expenses?all=1').set(as(admin)).expect(200);
    expect(all.body.expenses).toHaveLength(2);
    const notWidened = await request(serverFor(app)).get('/api/expenses?all=1').set(as(emp)).expect(200);
    expect(notWidened.body.expenses.map(e => e.id)).toEqual([mine.id]);
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
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(other)).send({ purpose: 'x' }).expect(404);   // a colleague does not see it at all
  });

  test('an admin corrects details on anyone\'s receipt, and the change log says who', async () => {
    const e = seed(emp);
    const r = await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(admin)).send({ merchant: 'Courtyard by Marriott', total: 150 }).expect(200);
    expect(r.body.expense).toMatchObject({ merchant: 'Courtyard by Marriott', total: 150 });
    expect(r.body).toMatchObject({ isOwner: false, canEditDetails: true, canAct: false, posted: false });
    const log = await request(serverFor(app)).get(`/api/expenses/${e.id}/changes`).set(as(emp)).expect(200);
    const merchant = log.body.changes.find(c => c.field === 'merchant');
    expect(merchant).toMatchObject({ oldValue: 'Courtyard', newValue: 'Courtyard by Marriott', actorRole: 'admin', via: 'app', actorName: expect.any(String) });
    expect(log.body.changes.find(c => c.field === 'total')).toMatchObject({ oldValue: '100.00', newValue: '150.00' });
    expect(log.body.changes.find(c => c.field === 'lines')).toBeTruthy();   // the single line followed the total
    // The details are the admin's to correct; the claim's actions are not.
    await request(serverFor(app)).put(`/api/expenses/${e.id}/lines`).set(as(admin)).send({ lines: [{ category: 'Lodging', amount: 100 }, { category: 'Meals', amount: 50 }] }).expect(200);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}/status`).set(as(admin)).send({ status: 'reviewed' }).expect(403);
    await request(serverFor(app)).post(`/api/expenses/${e.id}/reread`).set(as(admin)).expect(403);
    await request(serverFor(app)).delete(`/api/expenses/${e.id}`).set(as(admin)).expect(403);
    const reports = require('../store/reports');
    const theirs = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'T' });
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(admin)).send({ reportId: theirs.id }).expect(403);   // filing is the claimant's
    // Sending the case it is already in, beside a detail, is not filing.
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(admin)).send({ reportId: null, purpose: 'Site visit' }).expect(200);
    // The owner sees their own permissions.
    const own = await request(serverFor(app)).get(`/api/expenses/${e.id}`).set(as(emp)).expect(200);
    expect(own.body).toMatchObject({ isOwner: true, canEditDetails: true, canAct: true });
  });

  test('the change log is seen by whoever can see the receipt, and nobody else', async () => {
    const e = seed(emp);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ invoiceNo: 'INV-9' }).expect(200);
    const log = await request(serverFor(app)).get(`/api/expenses/${e.id}/changes`).set(as(admin)).expect(200);
    expect(log.body.changes).toEqual([expect.objectContaining({ field: 'invoiceNo', oldValue: null, newValue: 'INV-9', actorRole: 'owner' })]);
    await request(serverFor(app)).get(`/api/expenses/${e.id}/changes`).set(as(other)).expect(404);
    // Nothing changed, nothing logged.
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ invoiceNo: 'INV-9' }).expect(200);
    expect(require('../store/changes').list(e.id)).toHaveLength(1);
  });

  test('an admin of another company cannot see or edit', async () => {
    const outsider = await users.createUser({ email: 'x@else.sg', password: 'password123', role: 'admin', companyId: users.createCompany({ name: 'Else' }).id });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens[outsider.email] = jwt.sign({ id: outsider.id, email: outsider.email, role: 'admin' }, secret);
    const e = seed(emp);
    await request(serverFor(app)).get(`/api/expenses/${e.id}`).set(as(outsider)).expect(404);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(outsider)).send({ merchant: 'x' }).expect(404);
    await request(serverFor(app)).get(`/api/expenses/${e.id}/changes`).set(as(outsider)).expect(404);
  });

  test('a receipt in a case posted to Xero cannot be changed by anybody', async () => {
    const reports = require('../store/reports'); const wf = require('../reports/workflow'); const db = require('../db');
    const e = seed(emp, { status: 'reviewed', lines: [{ category: 'Lodging', amount: 100, baseAmount: 1.34, fxRate: 0.0134, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }] });
    const r = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'T' });
    reports.addExpense(r.id, e.id); wf.markClaimed(r.id, emp);
    db.prepare("UPDATE expense_reports SET xero_invoice_id = 'inv-1' WHERE id = ?").run(r.id);
    for (const who of [emp, admin]) {
      await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(who)).send({ purpose: 'x' }).expect(409);
      await request(serverFor(app)).put(`/api/expenses/${e.id}/lines`).set(as(who)).send({ lines: [{ amount: 100 }] }).expect(409);
      await request(serverFor(app)).post(`/api/expenses/${e.id}/fx`).set(as(who)).expect(409);
      await request(serverFor(app)).patch(`/api/expenses/${e.id}/fx`).set(as(who)).send({ rate: 0.0134, reason: 'x' }).expect(409);
    }
    const view = await request(serverFor(app)).get(`/api/expenses/${e.id}`).set(as(emp)).expect(200);
    expect(view.body).toMatchObject({ posted: true, canEditDetails: false, canAct: false });
  });

  test('lines must reconcile; a good split is stored with on-behalf', async () => {
    const e = seed(emp);
    await request(serverFor(app)).put(`/api/expenses/${e.id}/lines`).set(as(emp)).send({ lines: [{ category: 'Lodging', amount: 60 }, { category: 'Meals', amount: 30 }] }).expect(400);
    const ok = await request(serverFor(app)).put(`/api/expenses/${e.id}/lines`).set(as(emp))
      .send({ lines: [{ category: 'Lodging', amount: 60, onBehalfOf: 'Lim Wei Jie' }, { category: 'Meals', amount: 40 }] }).expect(200);
    expect(ok.body.expense.lines.map(l => l.amount)).toEqual([60, 40]);
    expect(ok.body.expense.lines[0].onBehalfOf).toBe('Lim Wei Jie');
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
    const files = require('../receipts/receipt-store').forUser(emp.id);
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
    await request(serverFor(app)).patch(`/api/expenses/${e.id}/fx`).set(as(emp)).send({ rate: 0.0136 }).expect(400);   // no reason
    // A claimant's rate may sit at most 5% from the day's: 0.02 is 49% off 0.0134.
    const far = await request(serverFor(app)).patch(`/api/expenses/${e.id}/fx`).set(as(emp)).send({ rate: 0.02, reason: 'card statement' }).expect(400);
    expect(far.body.error).toMatch(/49.3% from the day's rate/);
    r = await request(serverFor(app)).patch(`/api/expenses/${e.id}/fx`).set(as(emp)).send({ rate: 0.0136, reason: 'card statement' }).expect(200);
    expect(r.body.expense.lines[0]).toMatchObject({ fxRate: 0.0136, fxSource: 'manual', baseAmount: 1.36 });
    r = await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ total: 200 }).expect(200);
    expect(r.body.expense.lines[0]).toMatchObject({ fxRate: 0.0136, baseAmount: 2.72 });   // an override survives an edit
  });

  test('in a claimed case the details can still be corrected, and the case records it; the actions cannot', async () => {
    const reports = require('../store/reports'); const wf = require('../reports/workflow');
    const e = seed(emp, { status: 'reviewed', lines: [{ category: 'Lodging', amount: 100, baseAmount: 1.34, fxRate: 0.0134, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }] });
    const r = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'T' });
    const other = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'Other' });
    reports.addExpense(r.id, e.id); wf.markClaimed(r.id, emp);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ purpose: 'Client visit' }).expect(200);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(admin)).send({ invoiceNo: 'A-1' }).expect(200);
    const events = reports.listEvents(r.id);
    const edited = events.filter(ev => ev.action === 'edited');
    expect(edited).toHaveLength(2);
    expect(edited.map(ev => ev.note).join(' ')).toMatch(/by an admin/);
    // Filing, checking and deleting stay closed until the case is reopened.
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ reportId: other.id }).expect(409);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}/status`).set(as(emp)).send({ status: 'review-needed' }).expect(409);
    await request(serverFor(app)).delete(`/api/expenses/${e.id}`).set(as(emp)).expect(409);
    const view = await request(serverFor(app)).get(`/api/expenses/${e.id}`).set(as(emp)).expect(200);
    expect(view.body).toMatchObject({ locked: true, canEditDetails: true, canAct: false, posted: false });
  });

  test('delete removes the expense and the file once nothing references it', async () => {
    const receiptStore = require('../receipts/receipt-store');
    const files = receiptStore.forUser(emp.id);
    const name = files.save('del1', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    const r = store.createReceipt({ id: 'del1', companyId: emp.companyId, userId: emp.id, file: name, mime: 'image/jpeg', sha256: 'del' });
    const e = store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: r.id, status: 'review-needed', total: 1 });
    await request(serverFor(app)).delete(`/api/expenses/${e.id}`).set(as(admin)).expect(403);   // not an admin's to delete
    await request(serverFor(app)).delete(`/api/expenses/${e.id}`).set(as(emp)).expect(200);
    expect(store.getExpense(e.id)).toBeNull();
    expect(files.exists(name)).toBe(false);
    expect(store.getReceipt(r.id)).toBeNull();
  });

  test('correcting the currency drops a typed rate, which was typed for the other currency', async () => {
    const e = seed(emp);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}/fx`).set(as(emp)).send({ rate: 0.0136, reason: 'card statement' }).expect(200);
    const r = await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ currency: 'USD' }).expect(200);
    expect(r.body.expense.currency).toBe('USD');
    expect(r.body.expense.lines[0]).toMatchObject({ currency: 'USD', fxSource: 'frankfurter', fxRate: 0.0134, fxOverrideBy: null, baseAmount: 1.34 });
    // The same currency sent again — every save sends it — is not a change.
    await request(serverFor(app)).patch(`/api/expenses/${e.id}/fx`).set(as(emp)).send({ rate: 0.0136, reason: 'card statement' }).expect(200);
    const same = await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ currency: 'USD', purpose: 'x' }).expect(200);
    expect(same.body.expense.lines[0]).toMatchObject({ fxSource: 'manual', fxRate: 0.0136 });
  });

  test('the note that a currency was assumed goes when the currency is set, or the receipt is marked reviewed', async () => {
    const { currencyNote } = require('../receipts/read-receipt');
    const e = seed(emp, { currency: 'SGD', errorMsg: currencyNote('SGD') });
    let r = await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ purpose: 'x', currency: 'SGD' }).expect(200);
    expect(r.body.expense.errorMsg).toMatch(/SGD was assumed/);
    r = await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ currency: 'MYR' }).expect(200);
    expect(r.body.expense.errorMsg).toBeNull();
    const e2 = seed(emp, { currency: 'SGD', errorMsg: currencyNote('SGD') });
    r = await request(serverFor(app)).patch(`/api/expenses/${e2.id}/status`).set(as(emp)).send({ status: 'reviewed' }).expect(200);
    expect(r.body.expense.errorMsg).toBeNull();
  });
});
