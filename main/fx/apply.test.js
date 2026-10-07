jest.mock('./rates', () => ({ getRate: jest.fn() }));

describe('fx/apply', () => {
  let store, users, u, rates, apply;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); rates = require('./rates'); apply = require('./apply');
    rates.getRate.mockReset();
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
  });
  const exp = (currency, total, lines, extra = {}) => store.createExpense({ companyId: u.companyId, userId: u.id, status: 'review-needed', currency, total, receiptDate: '2026-09-04', lines, ...extra });

  test('a foreign expense gets the receipt-date rate on every line and a base total', async () => {
    rates.getRate.mockResolvedValue({ rate: 0.01341, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: '2026-09-18T03:00:00.000Z' });
    const e = exp('INR', 88188.77, [{ category: 'Lodging', amount: 43131.36 }, { category: 'Lodging', amount: 36713.34, onBehalfOf: 'Lim Wei Jie' }, { category: 'Meals', amount: 8344.07 }]);
    const out = await apply.applyFx(e.id);
    expect(out.pending).toBe(0);
    // `today` is the company's own date, which decides whether the live board may price the day.
    expect(rates.getRate).toHaveBeenCalledWith({ from: 'INR', to: 'SGD', date: '2026-09-04', force: false, manualOnly: false, today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
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

  test('submission_date policy prices at the day it arrived, company time; monthly_fixed needs a manual rate for the 1st of the month', async () => {
    users.updateCompany(u.companyId, { fxPolicy: 'submission_date' });
    rates.getRate.mockResolvedValue({ rate: 0.0133, rateDate: 'x', providerDate: 'x', source: 'frankfurter', fetchedAt: 'x' });
    const e = exp('INR', 100, [{ category: 'Meals', amount: 100 }]);
    await apply.applyFx(e.id);
    const { localDate } = require('../utils/zone-date');
    expect(rates.getRate.mock.calls[0][0].date).toBe(localDate('Asia/Singapore', new Date(e.createdAt)));
    users.updateCompany(u.companyId, { fxPolicy: 'monthly_fixed' });
    rates.getRate.mockResolvedValue({ rate: 0.0134, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'manual', fetchedAt: 'x' });
    await apply.applyFx(e.id, { force: true });
    expect(rates.getRate.mock.calls[1][0].date).toBe('2026-09-01');
    rates.getRate.mockResolvedValue({ rate: 0.0134, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'frankfurter', fetchedAt: 'x' });
    expect((await apply.applyFx(e.id, { force: true })).pending).toBe(1);   // a provider rate is not a fixed table
  });
  // An SGD receipt in an SGD company has no rate to choose. A typed rate used
  // to stick there, and "1.049" claimed 4.9% more than the receipt said, with
  // nothing on the PDF or the Xero bill to show it.
  test('a receipt in the base currency refuses a typed rate, and loses any it had', async () => {
    const e = exp('SGD', 1000, [{ category: 'Meals', amount: 1000 }]);
    const admin = { id: u.id, role: 'admin', email: 'a@solv.sg' };
    await expect(apply.overrideFx(e.id, { rate: 1.049, reason: 'card', actor: admin })).rejects.toThrow(/own currency/);
    expect(await apply.typedRateProblem(store.getExpense(e.id), 1.049, admin)).toMatch(/own currency/);
    store.updateLine(store.getExpense(e.id).lines[0].id, { fxRate: 1.049, fxOverrideBy: 'x', fxOverrideReason: 'old', baseAmount: 1049 });
    await apply.applyFx(e.id);
    expect(store.getExpense(e.id).lines[0]).toMatchObject({ fxRate: 1, fxOverrideBy: null, baseAmount: 1000 });
  });

  // The lines were read before the wait for the rate and written after it, so
  // a rate typed in between was overwritten without a word in the change log.
  test('a rate typed while a lookup is on its way is kept', async () => {
    const e = exp('INR', 100000, [{ category: 'Meals', amount: 100000 }]);
    let release;
    rates.getRate.mockImplementation(() => new Promise(r => { release = () => r({ rate: 0.0161, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: 'x' }); }));
    const sweeping = apply.applyFx(e.id);
    await new Promise(r => setImmediate(r));
    await apply.overrideFx(e.id, { rate: 0.0158, reason: 'Card statement', actor: { id: u.id, role: 'admin', email: 'a@solv.sg' } });
    release();
    await sweeping;
    expect(store.getExpense(e.id).lines[0]).toMatchObject({ fxRate: 0.0158, fxSource: 'manual', baseAmount: 1580 });
  });

  // Split while the rate was on its way, the old line ids no longer existed
  // and the write after the wait threw.
  test('a receipt split while its rate is fetched is priced on its new lines', async () => {
    const e = exp('INR', 100, [{ category: 'Meals', amount: 100 }]);
    let release;
    rates.getRate.mockImplementation(() => new Promise(r => { release = () => r({ rate: 0.02, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: 'x' }); }));
    const pricing = apply.applyFx(e.id);
    await new Promise(r => setImmediate(r));
    store.replaceLines(e.id, [{ category: 'Meals', amount: 60 }, { category: 'Lodging', amount: 40 }]);
    release();
    await expect(pricing).resolves.toMatchObject({ applied: 2 });
    expect(store.getExpense(e.id).lines.map(l => l.baseAmount)).toEqual([1.2, 0.8]);
  });
});
