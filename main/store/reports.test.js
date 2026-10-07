describe('store/reports', () => {
  let store, reports, users, u, m;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('./users'); store = require('./expenses'); reports = require('./reports');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123', name: 'Aisha' });
    m = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: u.companyId, name: 'Henry' });
  });
  const exp = (extra = {}) => store.createExpense({ companyId: u.companyId, userId: u.id, status: 'reviewed', currency: 'INR', total: 100, receiptDate: '2026-09-04',
    lines: [{ category: 'Lodging', amount: 60, baseAmount: 0.8, fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }, { category: 'Meals', amount: 40, baseAmount: 0.54, fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }], ...extra });

  test('numbers run per company and per year', () => {
    const year = require('../utils/zone-date').localDate('Asia/Singapore').slice(0, 4);
    const a = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'India trip' });
    const b = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Another' });
    expect(a.number).toBe(`EXP-${year}-0001`);
    expect(b.number).toBe(`EXP-${year}-0002`);
    expect(a.status).toBe('open');
  });

  // The server runs in UTC; Singapore's New Year arrives eight hours earlier.
  test("the number's year is the company's, not the server's", () => {
    jest.useFakeTimers({ now: new Date('2026-12-31T17:00:00Z'), doNotFake: ['setImmediate', 'nextTick'] });
    try {
      expect(reports.createReport({ companyId: u.companyId, userId: u.id, title: 'New Year' }).number).toMatch(/^EXP-2027-/);
    } finally { jest.useRealTimers(); }
  });

  // One with no amount was counted as waiting for a rate, which no rate fixes.
  test('a receipt with no amount is counted apart from one waiting for a rate', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'T' });
    reports.addExpense(r.id, exp({ lines: [] }).id);
    reports.addExpense(r.id, exp({ lines: [{ category: 'Meals', amount: 100 }] }).id);
    reports.addExpense(r.id, exp().id);
    expect(reports.getReport(r.id).totals).toMatchObject({ noAmount: 1, pendingRates: 1 });
    expect(reports.listReports({ userId: u.id })[0]).toMatchObject({ noAmount: 1, pendingRates: 1 });
  });

  test('filing expenses gives totals by category, a reimbursement, and flags what is not ready', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'India trip', advances: 0.5 });
    const e1 = exp(); const e2 = exp({ status: 'review-needed' }); const e3 = exp({ lines: [{ category: 'Meals', amount: 100 }] });
    reports.addExpense(r.id, e1.id); reports.addExpense(r.id, e2.id); reports.addExpense(r.id, e3.id);
    const full = reports.getReport(r.id);
    expect(full.expenses).toHaveLength(3);
    expect(full.totals.byCategory).toEqual({ Lodging: 1.6, Meals: 1.08 });
    expect(full.totals.totalBase).toBe(2.68);
    expect(full.totals.reimbursement).toBe(2.18);
    expect(full.totals.pendingRates).toBe(1);
    expect(full.totals.unreviewed).toBe(1);
    reports.removeExpense(r.id, e3.id);
    expect(store.getExpense(e3.id).reportId).toBeNull();
    expect(reports.getReport(r.id).totals.pendingRates).toBe(0);
  });

  test('list carries summary totals and filters by user and status', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'A' });
    reports.addExpense(r.id, exp().id);
    reports.createReport({ companyId: u.companyId, userId: m.id, title: 'B' });
    const mine = reports.listReports({ userId: u.id });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'A', expenseCount: 1, totalBase: 1.34, ownerName: 'Aisha' });
    expect(reports.listReports({ companyId: u.companyId })).toHaveLength(2);
    expect(reports.listReports({ companyId: u.companyId, status: 'claimed' })).toHaveLength(0);
    expect(mine[0].unreviewed).toBe(0);
    expect(reports.listReports({ userIds: [] })).toEqual([]);
  });

  test('events are recorded with the actor', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'A' });
    reports.addEvent(r.id, u.id, 'claimed', null);
    reports.addEvent(r.id, m.id, 'reopened', 'marked by mistake');
    const ev = reports.listEvents(r.id);
    expect(ev.map(e => [e.action, e.actorName])).toEqual([['created', 'Aisha'], ['claimed', 'Aisha'], ['reopened', 'Henry']]);
  });

  test('deleting an open case unfiles its expenses', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'A' });
    const e = exp(); reports.addExpense(r.id, e.id);
    reports.deleteReport(r.id);
    expect(reports.getReport(r.id)).toBeNull();
    expect(store.getExpense(e.id).reportId).toBeNull();
  });

  test('the case list and the case page count receipts without a rate the same way', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'T' });
    const e = exp({ lines: [{ category: 'Lodging', amount: 60 }, { category: 'Meals', amount: 40 }] });   // two unpriced lines
    reports.addExpense(r.id, e.id);
    const listed = reports.listReports({ userId: u.id }).find(x => x.id === r.id);
    expect(listed.pendingRates).toBe(1);
    expect(reports.getReport(r.id).totals.pendingRates).toBe(1);
  });

  test('head is the case row alone', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'T' });
    expect(reports.head(r.id)).toMatchObject({ id: r.id, status: 'open', userId: u.id, companyId: u.companyId, xeroInvoiceId: null });
    expect(reports.head('nope')).toBeNull();
  });
});
