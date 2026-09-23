const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('../receipts/receipt-parser', () => ({
  parseReceiptImage: jest.fn().mockResolvedValue(null), parseReceiptText: jest.fn().mockResolvedValue(null), parseReceiptPages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../pdf/render', () => ({ renderPdfPages: jest.fn().mockResolvedValue(null) }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.0134, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: 'x' }) }));

// A claimed case is only worth anything if every road into it obeys the lock.
// Each test here is a road that did not: one that crashed the server, two that
// changed a case after it was claimed, one that read a colleague's receipt,
// and one that let the wrong person declare a claim.
describe('guards that the case lock depends on', () => {
  let app, users, store, reports, wf, admin, emp, other, tokens;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses');
    reports = require('../store/reports'); wf = require('../reports/workflow');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    emp   = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express();
    app.use(express.json());
    app.use('/api/expenses', require('./expenses'));
    app.use('/api/receipts', require('./receipts'));
    app.use('/api/claims', require('./claims'));
    // The production error handler, so an unwrapped throw shows up as a 500
    // here rather than as a hung request.
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  });

  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const seed = (owner, { groupId = null, ...extra } = {}) => {
    // a group is a property of the receipt, which is what an import creates
    const r = store.createReceipt({ companyId: owner.companyId, userId: owner.id, file: 'r.jpg', mime: 'image/jpeg', sha256: `h${Math.random()}`, groupId });
    return store.createExpense({ companyId: owner.companyId, userId: owner.id, receiptId: r.id, status: 'reviewed', merchant: 'Courtyard', currency: 'SGD', total: 100, receiptDate: '2026-09-04',
      // priced already, so markClaimed() is not blocked by a pending rate
      lines: [{ category: 'Lodging', amount: extra.total ?? 100, baseAmount: extra.total ?? 100, fxRate: 1, fxSource: 'base', fxRateDate: '2026-09-04' }], ...extra });
  };
  const claimedCase = async () => {
    const r = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'Trip' });
    const e = seed(emp);
    reports.addExpense(r.id, e.id);
    wf.markClaimed(r.id, emp);
    return { report: reports.getReport(r.id), expense: e };
  };

  // ── the one-request crash ───────────────────────────────────────────────
  test('an unknown report id is refused, and does not reject into the process', async () => {
    const rejections = [];
    const onReject = err => rejections.push(err);
    process.on('unhandledRejection', onReject);
    try {
      const e = seed(emp, { status: 'review-needed' });
      const res = await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ reportId: 'no-such-report' });
      expect([400, 403, 404]).toContain(res.status);
      expect(typeof res.body.error).toBe('string');
      await new Promise(r => setImmediate(r));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onReject);
    }
  });

  // ── filing has to obey the same rules everywhere ────────────────────────
  test('an expense cannot be filed into a case that is already claimed', async () => {
    const { report } = await claimedCase();
    const late = seed(emp, { total: 5000, status: 'review-needed' });
    const res = await request(serverFor(app)).patch(`/api/expenses/${late.id}`).set(as(emp)).send({ reportId: report.id });
    expect(res.status).toBe(409);
    const after = reports.getReport(report.id);
    expect(after.expenses).toHaveLength(1);
    expect(after.totals.totalBase).toBe(100);
  });

  test('an expense cannot be filed into someone else\'s case', async () => {
    const theirs = reports.createReport({ companyId: admin.companyId, userId: admin.id, title: 'Not yours' });
    const mine = seed(emp);
    const res = await request(serverFor(app)).patch(`/api/expenses/${mine.id}`).set(as(emp)).send({ reportId: theirs.id });
    expect(res.status).toBe(403);
    expect(reports.getReport(theirs.id).expenses).toHaveLength(0);
  });

  test('filing into and out of your own open case still works', async () => {
    const draft = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'Mine' });
    const e = seed(emp);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ reportId: draft.id }).expect(200);
    expect(reports.getReport(draft.id).expenses).toHaveLength(1);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ reportId: '' }).expect(200);
    expect(reports.getReport(draft.id).expenses).toHaveLength(0);
  });

  // ── undoing an import must not reach into a claimed case ────────────────
  test('undoing a claim import leaves the expenses that are in a claimed case', async () => {
    const groupId = 'grp-1';
    const loose = seed(emp, { groupId, status: 'review-needed' });
    const filed = seed(emp, { groupId });
    const r = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'Trip' });
    reports.addExpense(r.id, filed.id);
    wf.markClaimed(r.id, emp);

    const res = await request(serverFor(app)).delete(`/api/claims/group/${groupId}`).set(as(emp)).expect(200);
    expect(res.body.removed).toBe(1);
    expect(res.body.kept).toHaveLength(1);
    expect(store.getExpense(filed.id)).toBeTruthy();
    expect(store.getExpense(loose.id)).toBeFalsy();
    expect(reports.getReport(r.id).expenses).toHaveLength(1);
  });

  // ── receipts are not company-wide reading ───────────────────────────────
  test('a colleague cannot mint a viewing token for someone else\'s receipt', async () => {
    const mine = seed(emp);
    const theirs = seed(admin);
    await request(serverFor(app)).get(`/api/receipts/${mine.receiptId || mine.receipt.id}/token`).set(as(emp)).expect(200);
    await request(serverFor(app)).get(`/api/receipts/${theirs.receipt.id}/token`).set(as(emp)).expect(404);
    await request(serverFor(app)).get(`/api/receipts/${mine.receipt.id}/token`).set(as(other)).expect(404);
    await request(serverFor(app)).get(`/api/receipts/${mine.receipt.id}/token`).set(as(admin)).expect(200);
  });

  // ── who owns the only step ──────────────────────────────────────────────
  // Claiming is the claimant saying they put it through, so nobody may declare
  // that on somebody else's behalf. An admin still may, to tidy up after
  // someone who has left.
  test('only the claimant, or an admin, can mark a case claimed or reopen it', async () => {
    const r = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'Trip' });
    reports.addExpense(r.id, seed(emp).id);
    expect(() => wf.markClaimed(r.id, other)).toThrow(/claimant/i);
    expect(wf.markClaimed(r.id, emp).status).toBe('claimed');
    expect(() => wf.reopen(r.id, other)).toThrow(/claimant/i);
    expect(wf.reopen(r.id, admin).status).toBe('open');

    const theirs = reports.createReport({ companyId: other.companyId, userId: other.id, title: 'Theirs' });
    reports.addExpense(theirs.id, seed(other).id);
    expect(wf.markClaimed(theirs.id, admin).status).toBe('claimed');
  });
});
