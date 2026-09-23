// Four things that stand between a provider's number and a figure somebody is
// paid: the two providers are compared, a rate that jumped is refused, a rate
// priced on the wrong day is marked, and a line left without one is retried.
describe('fx checks', () => {
  let db, rates, providers, apply, store, users, reports, wf, u;

  beforeEach(async () => {
    jest.resetModules();
    jest.doMock('./providers', () => ({ frankfurter: jest.fn(), erapi: jest.fn(), TIMEOUT: 5000, THIN_RATE: 0.1 }));
    require('../db/migrate').run();
    db = require('../db');
    providers = require('./providers');
    rates = require('./rates');
    apply = require('./apply');
    store = require('../store/expenses');
    users = require('../store/users');
    reports = require('../store/reports');
    wf = require('../reports/workflow');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
  });
  afterEach(() => jest.dontMock('./providers'));

  const ecb = (rate, date) => ({ rate, providerDate: date, source: 'frankfurter' });
  const erapi = (rate, date) => ({ rate, providerDate: date, source: 'open.er-api' });
  const today = () => new Date().toISOString().slice(0, 10);
  const exp = (currency, total, extra = {}) => store.createExpense({
    companyId: u.companyId, userId: u.id, status: 'reviewed', currency, total, receiptDate: '2026-09-04',
    lines: [{ category: 'Lodging', amount: total }], ...extra,
  });

  // ── 1. the two providers are compared ───────────────────────────────────
  test('providers that disagree are noted on the rate, and the ECB is still used', async () => {
    providers.frankfurter.mockResolvedValue(ecb(0.0134, today()));
    providers.erapi.mockResolvedValue(erapi(0.0120, today()));
    const r = await rates.getRate({ from: 'INR', to: 'SGD', date: today() });
    expect(r.rate).toBe(0.0134);                       // the ECB's, not the other one's
    expect(r.divergence).toBeCloseTo(0.116667, 5);     // 0.0134 against 0.0120
    expect(r.notes.join(' ')).toMatch(/disagree by 11.67%/);
    expect(r.blocked).toBeUndefined();                 // noted, not blocking
  });

  test('providers that agree leave no note', async () => {
    providers.frankfurter.mockResolvedValue(ecb(0.01341, today()));
    providers.erapi.mockResolvedValue(erapi(0.01339, today()));
    const r = await rates.getRate({ from: 'INR', to: 'SGD', date: today() });
    expect(r.notes).toEqual([]);
  });

  test('a historical date is not compared, because the second provider only knows today', async () => {
    providers.frankfurter.mockResolvedValue(ecb(0.01341, '2026-09-04'));
    providers.erapi.mockResolvedValue(erapi(0.0120, today()));
    const r = await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-04' });
    expect(providers.erapi).not.toHaveBeenCalled();
    expect(r.divergence).toBeNull();
  });

  // ── 2. a rate that jumped is refused ────────────────────────────────────
  test('a rate that moved more than a currency moves is not put on a line', async () => {
    providers.frankfurter.mockResolvedValue(ecb(0.0134, '2026-09-03'));
    await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-03' });

    providers.frankfurter.mockResolvedValue(ecb(0.0201, '2026-09-04'));   // +50% overnight
    const r = await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-04' });
    expect(r.moved).toBeCloseTo(0.5, 3);
    expect(r.blocked).toMatch(/INR moved 50.0% against SGD/);

    const e = exp('INR', 1000);
    const out = await apply.applyFx(e.id);
    expect(out.pending).toBe(1);
    expect(out.applied).toBe(0);
    const line = store.getExpense(e.id).lines[0];
    expect(line.fxRate).toBeNull();
    expect(line.baseAmount).toBeNull();
    expect(line.fxCheck).toMatch(/moved 50.0%/);
    expect(store.getExpense(e.id).fxPending).toBe(true);
  });

  test('finance entering the rate settles it, and the check is cleared', async () => {
    providers.frankfurter.mockResolvedValue(ecb(0.0134, '2026-09-03'));
    await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-03' });
    providers.frankfurter.mockResolvedValue(ecb(0.0201, '2026-09-04'));
    const e = exp('INR', 1000);
    await apply.applyFx(e.id);

    await apply.overrideFx(e.id, { rate: 0.0135, reason: 'card statement', actor: { email: 'finance@solv.sg' } });
    const line = store.getExpense(e.id).lines[0];
    expect(line.fxRate).toBe(0.0135);
    expect(line.baseAmount).toBe(13.5);
    expect(line.fxCheck).toBeNull();
    expect(store.getExpense(e.id).fxPending).toBe(false);
  });

  test('a small move is applied without comment', async () => {
    providers.frankfurter.mockResolvedValue(ecb(0.0134, '2026-09-03'));
    await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-03' });
    providers.frankfurter.mockResolvedValue(ecb(0.0138, '2026-09-04'));
    const e = exp('INR', 1000);
    const out = await apply.applyFx(e.id);
    expect(out.pending).toBe(0);
    expect(store.getExpense(e.id).lines[0].fxCheck).toBeNull();
  });

  // ── 3. a rate priced on the wrong day is marked ─────────────────────────
  test('a currency with no history is priced today, and the line says the day it was asked for', async () => {
    providers.frankfurter.mockResolvedValue(null);                       // the ECB does not publish the dong
    providers.erapi.mockResolvedValue(erapi(0.000049, today()));
    const e = exp('VND', 12000000);
    await apply.applyFx(e.id);
    const line = store.getExpense(e.id).lines[0];
    expect(line.fxSource).toBe('open.er-api');
    expect(line.fxAskedDate).toBe('2026-09-04');       // the receipt's date
    expect(line.fxRateDate).toBe(today());             // the day actually priced
    expect(line.fxNotOnTheDay).toBe(true);
  });

  test('a weekend receipt takes the previous business day and is not marked', async () => {
    providers.frankfurter.mockResolvedValue(ecb(0.01341, '2026-09-04'));  // Friday, for a Saturday receipt
    const e = exp('INR', 1000, { receiptDate: '2026-09-05' });
    await apply.applyFx(e.id);
    const line = store.getExpense(e.id).lines[0];
    expect(line.fxAskedDate).toBe('2026-09-05');
    expect(line.fxRateDate).toBe('2026-09-04');
    expect(line.fxNotOnTheDay).toBe(false);            // priced before the receipt, which is the ECB being closed
  });

  // ── 4. a line left without a rate is retried ────────────────────────────
  test('the sweeper prices what a provider outage left behind, and leaves locked expenses alone', async () => {
    providers.frankfurter.mockResolvedValue(null);
    providers.erapi.mockResolvedValue(null);
    const stranded = exp('INR', 1000);
    const filed = exp('INR', 500);
    await apply.applyFx(stranded.id);
    await apply.applyFx(filed.id);
    expect(store.getExpense(stranded.id).fxPending).toBe(true);

    // the second one goes into a case that is claimed, so it is off limits
    const rep = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Trip' });
    reports.addExpense(rep.id, filed.id);
    db.prepare("UPDATE expense_reports SET status = 'claimed' WHERE id = ?").run(rep.id);
    expect(wf.isLocked(store.getExpense(filed.id))).toBe(true);

    providers.frankfurter.mockResolvedValue(ecb(0.0134, '2026-09-04'));   // the provider comes back
    const sweeper = require('./sweeper');
    const out = await sweeper.sweep();

    expect(out.priced).toBe(1);
    // the locked one is excluded by the query now rather than looked at and
    // skipped, so it never enters the batch at all
    expect(out.looked).toBe(1);
    expect(store.getExpense(stranded.id).fxPending).toBe(false);
    expect(store.getExpense(stranded.id).lines[0].baseAmount).toBe(13.4);
    expect(store.getExpense(filed.id).lines[0].fxRate).toBeNull();        // untouched
  });

  test('the sweeper does not overwrite a rate somebody typed in', async () => {
    providers.frankfurter.mockResolvedValue(null);
    providers.erapi.mockResolvedValue(null);
    const e = exp('INR', 1000);
    await apply.applyFx(e.id);
    await apply.overrideFx(e.id, { rate: 0.0135, reason: 'card statement', actor: { email: 'finance@solv.sg' } });

    providers.frankfurter.mockResolvedValue(ecb(0.0134, '2026-09-04'));
    await require('./sweeper').sweep();
    expect(store.getExpense(e.id).lines[0].fxRate).toBe(0.0135);
  });
});

// What an audit found once the checks were in: the thing that can withhold a
// figure from somebody's pay was built on a baseline it did not qualify, and a
// block, once written, could not be lifted by anything the app offers.
describe('fx checks — a block has to be escapable', () => {
  let db, rates, providers, apply, store, users, u;

  beforeEach(async () => {
    jest.resetModules();
    jest.doMock('./providers', () => ({ frankfurter: jest.fn(), erapi: jest.fn(), TIMEOUT: 5000, THIN_RATE: 0.1 }));
    require('../db/migrate').run();
    db = require('../db'); providers = require('./providers'); rates = require('./rates');
    apply = require('./apply'); store = require('../store/expenses'); users = require('../store/users');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
  });
  afterEach(() => jest.dontMock('./providers'));

  const ecb = (rate, date) => ({ rate, providerDate: date, source: 'frankfurter' });

  test('a refused rate is not stored, so it cannot become tomorrow\'s baseline', async () => {
    providers.frankfurter.mockResolvedValue(ecb(0.0134, '2026-09-01'));
    await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-01' });

    providers.frankfurter.mockResolvedValue(ecb(0.0067, '2026-09-02'));   // a glitch, half the rate
    const bad = await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-02' });
    expect(bad.blocked).toMatch(/moved/);
    expect(db.prepare("SELECT COUNT(*) n FROM fx_rates WHERE rate_date = '2026-09-02'").get().n).toBe(0);

    // the day after, the correct rate is measured against 1 Sep, not the glitch
    providers.frankfurter.mockResolvedValue(ecb(0.01342, '2026-09-03'));
    const good = await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-03' });
    expect(good.blocked).toBeUndefined();
    expect(good.rate).toBe(0.01342);
  });

  test('a rate somebody typed in is never the baseline a provider is judged against', async () => {
    rates.setManualRate({ from: 'THB', to: 'SGD', date: '2026-09-01', rate: 0.05, by: 'finance@solv.sg' });  // a typo; the real rate is ~0.04
    providers.frankfurter.mockResolvedValue(ecb(0.0401, '2026-09-02'));
    const r = await rates.getRate({ from: 'THB', to: 'SGD', date: '2026-09-02' });
    expect(r.blocked).toBeUndefined();
    expect(r.rate).toBe(0.0401);
  });

  test('Refresh rate reaches past the cache, so a block that was wrong can be settled', async () => {
    providers.frankfurter.mockResolvedValue(ecb(0.0134, '2026-09-01'));
    await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-01' });
    providers.frankfurter.mockResolvedValue(ecb(0.0134, '2026-09-02'));
    await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-02' });

    // a cached rate is served without asking anyone
    providers.frankfurter.mockClear();
    await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-02' });
    expect(providers.frankfurter).not.toHaveBeenCalled();

    // unless the person asked for it again
    await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-02', force: true });
    expect(providers.frankfurter).toHaveBeenCalled();
  });

  test('a legitimate move over a longer gap is allowed, a wild one is not', () => {
    expect(rates.allowedMove(1)).toBeCloseTo(0.10, 5);
    expect(rates.allowedMove(9)).toBeCloseTo(0.30, 5);       // scales with the gap
    expect(rates.allowedMove(100)).toBeCloseTo(0.30, 5);     // and is capped
  });

  test('the sweeper skips what it can never price, so newer receipts are reached', async () => {
    providers.frankfurter.mockResolvedValue(null);
    providers.erapi.mockResolvedValue(null);
    const mk = () => store.createExpense({ companyId: u.companyId, userId: u.id, status: 'review-needed', currency: 'INR', total: 100,
      receiptDate: '2026-09-04', lines: [{ category: 'Other', amount: 100, currency: 'INR' }] });
    const stuck = mk();
    const fresh = mk();
    await apply.applyFx(stuck.id);
    await apply.applyFx(fresh.id);
    // the first one is waiting on a person, not on a provider
    store.updateLine(store.getExpense(stuck.id).lines[0].id, { fxCheck: 'INR moved 50.0% against SGD. Check it.' });

    providers.frankfurter.mockResolvedValue(ecb(0.0134, '2026-09-04'));
    const out = await require('./sweeper').sweep();
    expect(out.priced).toBe(1);
    expect(store.getExpense(fresh.id).fxPending).toBe(false);
    expect(store.getExpense(stuck.id).fxPending).toBe(true);   // still waiting for a person
  });
});
