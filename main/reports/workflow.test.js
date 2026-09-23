describe('reports/workflow', () => {
  let store, reports, users, wf, owner, other, admin;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports'); wf = require('./workflow');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    owner = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
  });
  const ready = (extra = {}) => store.createExpense({ companyId: owner.companyId, userId: owner.id, status: 'reviewed', currency: 'SGD', total: 10, receiptDate: '2026-09-04', merchant: 'Grab',
    lines: [{ category: 'Air & Transport', amount: 10, baseAmount: 10, fxRate: 1, fxSource: 'base', fxRateDate: '2026-09-04', fxFetchedAt: 'x' }], ...extra });
  const fresh = () => reports.createReport({ companyId: owner.companyId, userId: owner.id, title: 'T' });

  test('a new case is open, and open is the only editable state', () => {
    const r = fresh();
    expect(r.status).toBe('open');
    expect(wf.isEditable(r)).toBe(true);
    expect(wf.EDITABLE.has('claimed')).toBe(false);
  });

  // Claiming carries the checks that submitting used to. A claim with an
  // unchecked receipt or an unpriced line is not one anybody could have made.
  test('claiming needs the owner, at least one receipt, every receipt checked and priced', () => {
    const r = fresh();
    expect(() => wf.markClaimed(r.id, owner)).toThrow(/at least one/);
    reports.addExpense(r.id, ready({ status: 'review-needed' }).id);
    expect(() => wf.markClaimed(r.id, owner)).toThrow(/not checked/);
    const r2 = fresh(); reports.addExpense(r2.id, ready({ lines: [{ category: 'Meals', amount: 10 }] }).id);
    expect(() => wf.markClaimed(r2.id, owner)).toThrow(/rate/);
    const r3 = fresh(); const e = ready(); reports.addExpense(r3.id, e.id);
    expect(() => wf.markClaimed(r3.id, other)).toThrow(/claimant/);
    const out = wf.markClaimed(r3.id, owner);
    expect(out.status).toBe('claimed');
    expect(out.claimedAt).toBeTruthy();
    expect(out.events.at(-1).action).toBe('claimed');
    expect(wf.isEditable(out)).toBe(false);
    expect(() => wf.markClaimed(r3.id, owner)).toThrow(/already/);
    // the receipts inside went in together, so they are claimed together
    expect(store.getExpense(e.id).claimed).toBe(true);
  });

  test('an admin may mark somebody else\'s case claimed, to tidy up', () => {
    const r = fresh(); reports.addExpense(r.id, ready().id);
    expect(wf.markClaimed(r.id, admin).status).toBe('claimed');
  });

  // Mistakes happen, and record-only means nothing downstream breaks when one
  // is undone.
  test('a claimed case can be reopened by its owner or an admin, and its receipts with it', () => {
    const r = fresh(); const e = ready(); reports.addExpense(r.id, e.id);
    expect(() => wf.reopen(r.id, owner)).toThrow(/already open/);
    wf.markClaimed(r.id, owner);
    expect(() => wf.reopen(r.id, other)).toThrow(/claimant/);
    const out = wf.reopen(r.id, owner);
    expect(out.status).toBe('open');
    expect(out.claimedAt).toBeNull();
    expect(out.events.at(-1).action).toBe('reopened');
    expect(wf.isEditable(out)).toBe(true);
    expect(store.getExpense(e.id).claimed).toBe(false);
    wf.markClaimed(r.id, owner);
    expect(wf.reopen(r.id, admin).status).toBe('open');
  });

  test('a receipt can be claimed on its own, and unclaimed again', () => {
    const e = ready();
    expect(store.getExpense(e.id).claimed).toBe(false);
    expect(() => wf.markExpenseClaimed(e.id, other)).toThrow(/claimant/);
    expect(wf.markExpenseClaimed(e.id, owner).claimed).toBe(true);
    expect(wf.markExpenseClaimed(e.id, owner, false).claimed).toBe(false);
  });

  // Claiming one receipt out of a case says nothing about the case itself.
  test('claiming a receipt inside a case does not claim the case', () => {
    const r = fresh(); const e = ready(); reports.addExpense(r.id, e.id);
    wf.markExpenseClaimed(e.id, owner);
    expect(reports.getReport(r.id).status).toBe('open');
  });

  test('an expense in a claimed case is locked, and free again once it is reopened', () => {
    const r = fresh(); const e = ready(); reports.addExpense(r.id, e.id);
    expect(wf.isLocked(store.getExpense(e.id))).toBe(false);
    wf.markClaimed(r.id, owner);
    expect(wf.isLocked(store.getExpense(e.id))).toBe(true);
    wf.reopen(r.id, owner);
    expect(wf.isLocked(store.getExpense(e.id))).toBe(false);
  });
});
