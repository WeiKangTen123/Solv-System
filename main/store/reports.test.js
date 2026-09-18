describe('store/reports', () => {
  let store, reports, users, u, m;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('./users'); store = require('./expenses'); reports = require('./reports');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123', name: 'Elaine' });
    m = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: u.companyId, role: 'manager', name: 'Henry' });
  });
  const exp = (extra = {}) => store.createExpense({ companyId: u.companyId, userId: u.id, status: 'reviewed', currency: 'INR', total: 100, receiptDate: '2026-09-04',
    lines: [{ category: 'Lodging', amount: 60, baseAmount: 0.8, fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }, { category: 'Meals', amount: 40, baseAmount: 0.54, fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }], ...extra });

  test('numbers run per company and per year', () => {
    const a = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'India trip' });
    const b = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Another' });
    expect(a.number).toBe(`EXP-${new Date().getFullYear()}-0001`);
    expect(b.number).toBe(`EXP-${new Date().getFullYear()}-0002`);
    expect(a.status).toBe('draft');
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
    expect(mine[0]).toMatchObject({ title: 'A', expenseCount: 1, totalBase: 1.34, ownerName: 'Elaine' });
    expect(reports.listReports({ companyId: u.companyId })).toHaveLength(2);
    expect(reports.listReports({ companyId: u.companyId, status: 'submitted' })).toHaveLength(0);
    expect(reports.listReports({ userIds: [] })).toEqual([]);
  });

  test('events are recorded with the actor', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'A' });
    reports.addEvent(r.id, u.id, 'submitted', null);
    reports.addEvent(r.id, m.id, 'approved', 'looks right');
    const ev = reports.listEvents(r.id);
    expect(ev.map(e => [e.action, e.actorName])).toEqual([['created', 'Elaine'], ['submitted', 'Elaine'], ['approved', 'Henry']]);
  });

  test('deleting a draft unfiles its expenses', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'A' });
    const e = exp(); reports.addExpense(r.id, e.id);
    reports.deleteReport(r.id);
    expect(reports.getReport(r.id)).toBeNull();
    expect(store.getExpense(e.id).reportId).toBeNull();
  });
});
