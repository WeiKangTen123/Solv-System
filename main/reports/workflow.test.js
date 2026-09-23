describe('reports/workflow', () => {
  let store, reports, users, wf, owner, mgr, other, fin, admin;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports'); wf = require('./workflow');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    mgr   = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: admin.companyId, role: 'manager' });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId, role: 'manager' });
    fin   = await users.createUser({ email: 'f@solv.sg', password: 'password123', companyId: admin.companyId, role: 'finance' });
    owner = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, managerId: mgr.id });
  });
  const ready = (extra = {}) => store.createExpense({ companyId: owner.companyId, userId: owner.id, status: 'reviewed', currency: 'SGD', total: 10, receiptDate: '2026-09-04', merchant: 'Grab',
    lines: [{ category: 'Air & Transport', amount: 10, baseAmount: 10, fxRate: 1, fxSource: 'base', fxRateDate: '2026-09-04', fxFetchedAt: 'x' }], ...extra });
  const draft = () => reports.createReport({ companyId: owner.companyId, userId: owner.id, title: 'T' });

  test('submit needs the owner, at least one expense, every expense reviewed and priced', () => {
    const r = draft();
    expect(() => wf.submit(r.id, owner)).toThrow(/at least one/);
    reports.addExpense(r.id, ready({ status: 'review-needed' }).id);
    expect(() => wf.submit(r.id, owner)).toThrow(/reviewed/);
    const r2 = draft(); reports.addExpense(r2.id, ready({ lines: [{ category: 'Meals', amount: 10 }] }).id);
    expect(() => wf.submit(r2.id, owner)).toThrow(/rate/);
    const r3 = draft(); reports.addExpense(r3.id, ready().id);
    expect(() => wf.submit(r3.id, mgr)).toThrow(/owner/);
    const out = wf.submit(r3.id, owner);
    expect(out.status).toBe('submitted');
    expect(out.submittedAt).toBeTruthy();
    expect(out.events.at(-1).action).toBe('submitted');
    expect(() => wf.submit(r3.id, owner)).toThrow(/already/);
  });

  test("approve: the owner's manager, finance or admin, never the owner or another manager", () => {
    const r = draft(); reports.addExpense(r.id, ready().id); wf.submit(r.id, owner);
    expect(() => wf.approve(r.id, owner)).toThrow(/own/);
    expect(() => wf.approve(r.id, other)).toThrow(/manager/);
    expect(wf.canDecide(r.id, mgr)).toBe(true);
    expect(wf.canDecide(r.id, fin)).toBe(true);
    const out = wf.approve(r.id, mgr);
    expect(out).toMatchObject({ status: 'approved', approvedBy: mgr.id });
    expect(out.approvedAt).toBeTruthy();
  });

  test('reject needs a reason and reopens the report for editing and resubmission', () => {
    const r = draft(); reports.addExpense(r.id, ready().id); wf.submit(r.id, owner);
    expect(() => wf.reject(r.id, mgr, '')).toThrow(/reason/);
    const out = wf.reject(r.id, mgr, 'Missing purpose');
    expect(out).toMatchObject({ status: 'rejected', rejectedReason: 'Missing purpose' });
    expect(wf.isEditable(out)).toBe(true);
    expect(wf.submit(r.id, owner).status).toBe('submitted');
  });

  test('claimed: the owner, only after approval; then the report is final', () => {
    const r = draft(); const e = ready(); reports.addExpense(r.id, e.id); wf.submit(r.id, owner);
    expect(() => wf.markClaimed(r.id, owner)).toThrow(/approved/);
    wf.approve(r.id, mgr);
    // Neither the manager who approved it nor finance may say it was claimed:
    // only the person who would have put it through knows that.
    expect(() => wf.markClaimed(r.id, mgr)).toThrow(/claimant/);
    expect(() => wf.markClaimed(r.id, fin)).toThrow(/claimant/);
    const out = wf.markClaimed(r.id, owner);
    expect(out.status).toBe('claimed');
    expect(out.claimedAt).toBeTruthy();
    expect(wf.isEditable(out)).toBe(false);
    // the receipts inside went in together, so they are claimed together
    expect(store.getExpense(e.id).claimed).toBe(true);
  });

  test('a receipt can be claimed on its own, and unclaimed again', () => {
    const e = ready();
    expect(store.getExpense(e.id).claimed).toBe(false);
    expect(() => wf.markExpenseClaimed(e.id, mgr)).toThrow(/claimant/);
    expect(wf.markExpenseClaimed(e.id, owner).claimed).toBe(true);
    expect(wf.markExpenseClaimed(e.id, owner, false).claimed).toBe(false);
  });

  // Claiming one receipt out of a case says nothing about the case itself.
  test('claiming a receipt inside a report does not claim the report', () => {
    const r = draft(); const e = ready(); reports.addExpense(r.id, e.id);
    wf.markExpenseClaimed(e.id, owner);
    expect(reports.getReport(r.id).status).toBe('draft');
  });

  test('an expense in a submitted report is locked', () => {
    const r = draft(); const e = ready(); reports.addExpense(r.id, e.id);
    expect(wf.isLocked(store.getExpense(e.id))).toBe(false);
    wf.submit(r.id, owner);
    expect(wf.isLocked(store.getExpense(e.id))).toBe(true);
    wf.reject(r.id, mgr, 'fix it');
    expect(wf.isLocked(store.getExpense(e.id))).toBe(false);
  });
});
