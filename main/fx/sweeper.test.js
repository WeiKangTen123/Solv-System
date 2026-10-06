jest.mock('./rates', () => ({ getRate: jest.fn() }));

// The sweeper's query is the only thing that decides what gets re-priced, so
// it is tested against real rows. An unpriced receipt inside an OPEN case is
// the common case — every receipt lives in a case from the moment it lands —
// and the query used to name statuses from before cases, so it matched none.
describe('fx/sweeper', () => {
  let db, store, users, reports, wf, rates, sweeper, u;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    db = require('../db'); users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports');
    wf = require('../reports/workflow'); rates = require('./rates'); sweeper = require('./sweeper');
    rates.getRate.mockReset();
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
  });
  const expense = (lines, extra = {}) => store.createExpense({ companyId: u.companyId, userId: u.id, status: 'review-needed', merchant: 'JW', currency: 'INR', total: 100, receiptDate: '2026-09-04', lines, ...extra });
  const caseWith = (...ids) => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, kind: 'case', title: 'T' });
    for (const id of ids) reports.addExpense(r.id, id);
    return r;
  };

  test('a receipt waiting for a rate inside an open case is swept and priced', async () => {
    const e = expense([{ category: 'Meals', amount: 100 }]);
    caseWith(e.id);
    expect(sweeper.pendingExpenseIds()).toEqual([e.id]);
    rates.getRate.mockResolvedValue({ rate: 0.0134, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: 'x' });
    expect(await sweeper.sweep()).toMatchObject({ looked: 1, priced: 1, stillPending: 0, locked: 0 });
    expect(store.getExpense(e.id).baseTotal).toBe(1.34);
  });

  test('a receipt in no case at all is swept too', async () => {
    const e = expense([{ category: 'Meals', amount: 100 }]);
    expect(sweeper.pendingExpenseIds()).toEqual([e.id]);
  });

  test('a claimed case, a typed rate and a refused rate are left for a person', async () => {
    const priced = { category: 'Meals', amount: 100, fxRate: 0.0134, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x', baseAmount: 1.34 };
    const claimed = expense([priced], { status: 'reviewed' });
    const r = caseWith(claimed.id); wf.markClaimed(r.id, u);
    db.prepare('UPDATE expense_lines SET fx_rate = NULL, base_cents = NULL WHERE expense_id = ?').run(claimed.id);
    const typed = expense([{ category: 'Meals', amount: 100, fxOverrideBy: 'e@solv.sg' }]);
    const refused = expense([{ category: 'Meals', amount: 100 }]);
    store.updateLine(refused.lines[0].id, { fxCheck: 'INR moved 12.0% against SGD since the last rate we had.' });
    caseWith(typed.id, refused.id);
    expect(sweeper.pendingExpenseIds()).toEqual([]);
    expect(await sweeper.sweep()).toMatchObject({ looked: 0, priced: 0 });
    expect(rates.getRate).not.toHaveBeenCalled();
  });

  test('a line that cannot be priced waits an hour, so newer lines behind it are reached', async () => {
    const stuck = expense([{ category: 'Meals', amount: 100 }], { currency: 'XYZ' });
    const later = expense([{ category: 'Meals', amount: 100 }]);
    rates.getRate.mockImplementation(async ({ from }) => (from === 'XYZ' ? null : { rate: 0.0134, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: 'x' }));
    await sweeper.sweep();
    expect(store.getExpense(later.id).baseTotal).toBe(1.34);
    expect(sweeper.pendingExpenseIds()).toEqual([]);                                   // tried a moment ago
    expect(sweeper.pendingExpenseIds(25, Date.now() + 61 * 60 * 1000)).toEqual([stuck.id]);
  });
});
