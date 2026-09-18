jest.mock('./rates', () => ({ getRate: jest.fn() }));

describe('fx/apply', () => {
  let store, users, u, rates, apply;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../utils/users'); store = require('../store/expenses'); rates = require('./rates'); apply = require('./apply');
    rates.getRate.mockReset();
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
  });
  const exp = (currency, total, lines, extra = {}) => store.createExpense({ companyId: u.companyId, userId: u.id, status: 'review-needed', currency, total, receiptDate: '2026-09-04', lines, ...extra });

  test('a foreign expense gets the receipt-date rate on every line and a base total', async () => {
    rates.getRate.mockResolvedValue({ rate: 0.01341, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: '2026-09-18T03:00:00.000Z' });
    const e = exp('INR', 88188.77, [{ category: 'Lodging', amount: 43131.36 }, { category: 'Lodging', amount: 36713.34, onBehalfOf: 'Tan Suan Kuan' }, { category: 'Meals', amount: 8344.07 }]);
    const out = await apply.applyFx(e.id);
    expect(out.pending).toBe(0);
    expect(rates.getRate).toHaveBeenCalledWith({ from: 'INR', to: 'SGD', date: '2026-09-04' });
    const after = store.getExpense(e.id);
    expect(after.lines.map(l => l.baseAmount)).toEqual([578.39, 492.33, 111.89]);
    expect(after.lines[0]).toMatchObject({ fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxPolicy: 'receipt_date' });
    expect(after.baseTotal).toBe(1182.61);
    expect(after.fxPending).toBe(false);
  });

  test('a base-currency expense is rate 1 from source base', async () => {
    const e = exp('SGD', 18.4, [{ category: 'Air & Transport', amount: 18.4 }]);
    await apply.applyFx(e.id);
    expect(store.getExpense(e.id).lines[0]).toMatchObject({ fxRate: 1, fxSource: 'base', baseAmount: 18.4 });
    expect(rates.getRate).not.toHaveBeenCalled();
  });

  test('no rate anywhere leaves the lines pending', async () => {
    rates.getRate.mockResolvedValue(null);
    const e = exp('ZZZ', 10, [{ category: 'Other', amount: 10 }]);
    expect((await apply.applyFx(e.id)).pending).toBe(1);
    expect(store.getExpense(e.id).fxPending).toBe(true);
  });

  test('an override sticks through a refresh and records who and why', async () => {
    rates.getRate.mockResolvedValue({ rate: 0.01341, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: 'x' });
    const e = exp('INR', 100, [{ category: 'Meals', amount: 100 }]);
    await apply.applyFx(e.id);
    await apply.overrideFx(e.id, { rate: 0.0135, reason: 'Bank statement rate', actor: { id: u.id, email: 'e@solv.sg' } });
    const after = store.getExpense(e.id);
    expect(after.lines[0]).toMatchObject({ fxRate: 0.0135, fxSource: 'manual', fxOverrideBy: 'e@solv.sg', fxOverrideReason: 'Bank statement rate', baseAmount: 1.35 });
    await apply.applyFx(e.id);
    expect(store.getExpense(e.id).lines[0].fxRate).toBe(0.0135);
    await apply.applyFx(e.id, { force: true });
    expect(store.getExpense(e.id).lines[0].fxRate).toBe(0.01341);
    await expect(apply.overrideFx(e.id, { rate: 0.0135, reason: '', actor: { email: 'x' } })).rejects.toThrow(/why/);
  });

  test('submission_date policy prices at today; monthly_fixed needs a manual rate for the 1st of the month', async () => {
    users.updateCompany(u.companyId, { fxPolicy: 'submission_date' });
    rates.getRate.mockResolvedValue({ rate: 0.0133, rateDate: 'x', providerDate: 'x', source: 'frankfurter', fetchedAt: 'x' });
    const e = exp('INR', 100, [{ category: 'Meals', amount: 100 }]);
    await apply.applyFx(e.id);
    expect(rates.getRate.mock.calls[0][0].date).toBe(new Date().toISOString().slice(0, 10));
    users.updateCompany(u.companyId, { fxPolicy: 'monthly_fixed' });
    rates.getRate.mockResolvedValue({ rate: 0.0134, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'manual', fetchedAt: 'x' });
    await apply.applyFx(e.id, { force: true });
    expect(rates.getRate.mock.calls[1][0].date).toBe('2026-09-01');
    rates.getRate.mockResolvedValue({ rate: 0.0134, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'frankfurter', fetchedAt: 'x' });
    expect((await apply.applyFx(e.id, { force: true })).pending).toBe(1);   // a provider rate is not a fixed table
  });
});
