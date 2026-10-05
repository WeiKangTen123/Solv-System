// The live board and the daily close. Providers are mocked at the module
// edge; crossRate is the real one, because reading a pair out of a table is
// exactly what is under test.
jest.mock('./providers', () => {
  const actual = jest.requireActual('./providers');
  return { ...actual, frankfurter: jest.fn(), erapi: jest.fn(), frankfurterAll: jest.fn(), erapiAll: jest.fn(), oxrAll: jest.fn() };
});

describe('fx/live', () => {
  let db, live, rates, providers, store, users, apply, zone, u, today, yesterday;

  // Tables as the providers return them: units of each currency per 1 SGD.
  const ecb = rates_ => ({ source: 'frankfurter', base: 'SGD', providerDate: today, providerTime: null, rates: rates_ });
  const er  = rates_ => ({ source: 'open.er-api', base: 'SGD', providerDate: today, providerTime: `${today}T00:02:31.000Z`, rates: rates_ });

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db = require('../db'); providers = require('./providers'); rates = require('./rates'); live = require('./live');
    store = require('../store/expenses'); users = require('../store/users'); apply = require('./apply'); zone = require('../utils/zone-date');
    for (const f of ['frankfurter', 'erapi', 'frankfurterAll', 'erapiAll', 'oxrAll']) providers[f].mockReset();
    u = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    today = zone.localDate('Asia/Singapore');
    yesterday = zone.addDays(today, -1);
    providers.frankfurterAll.mockResolvedValue(ecb({ INR: 75, MYR: 3.2 }));
    providers.erapiAll.mockResolvedValue(er({ INR: 75.3, MYR: 3.19, VND: 20000 }));
  });

  const expense = (currency, total, extra = {}) => store.createExpense({
    companyId: u.companyId, userId: u.id, status: 'review-needed', merchant: 'M', currency, total, receiptDate: today,
    lines: [{ category: 'Meals', amount: total }], ...extra,
  });

  test('watches every currency a receipt uses, plus the ones an admin adds, never the base', () => {
    expense('INR', 1000); expense('INR', 500); expense('SGD', 10);
    expect(() => live.watch(u.companyId, 'SGD')).toThrow(/own currency/);
    expect(() => live.watch(u.companyId, 'rupees')).toThrow(/3-letter/);
    live.watch(u.companyId, 'myr', 'a@solv.sg');
    expect(live.watched(u.companyId).map(w => [w.currency, w.receipts, w.pinned])).toEqual([['INR', 2, false], ['MYR', 0, true]]);
    expect(live.unwatch(u.companyId, 'INR')).toBe(false);      // receipts keep it on the board
    expect(live.unwatch(u.companyId, 'MYR')).toBe(true);
  });

  test('one request per source prices every watched currency: the ECB first, the other feed for the rest', async () => {
    expense('INR', 1000); expense('VND', 500000);
    const out = await live.refresh(u.companyId);
    expect(out).toMatchObject({ refreshed: 2, missing: [], source: 'frankfurter' });
    expect(providers.frankfurterAll).toHaveBeenCalledTimes(1);
    expect(providers.erapiAll).toHaveBeenCalledTimes(1);
    const inr = rates.liveRate('INR', 'SGD');
    expect(inr).toMatchObject({ source: 'frankfurter', providerDate: today });
    expect(inr.rate).toBeCloseTo(1 / 75, 12);
    expect(inr.divergence).toBeCloseTo((1 / 75 - 1 / 75.3) / (1 / 75.3), 9);
    expect(rates.liveRate('VND', 'SGD')).toMatchObject({ source: 'open.er-api', divergence: null });
  });

  test('an admin refresh is held to one a minute', async () => {
    expense('INR', 1000);
    await live.refresh(u.companyId, { manual: true });
    expect(await live.refresh(u.companyId, { manual: true })).toMatchObject({ throttled: true });
    expect(providers.frankfurterAll).toHaveBeenCalledTimes(1);
  });

  test('the board shows the live rate, the other direction, and the move since the last close', async () => {
    expense('INR', 1000);
    rates.recordClose({ from: 'INR', to: 'SGD', date: yesterday, rate: 1 / 76, source: 'frankfurter', providerDate: yesterday });
    await live.refresh(u.companyId);
    const b = live.board(u.companyId);
    expect(b).toMatchObject({ base: 'SGD', today, closesAt: '23:55', closedToday: false, source: { keyed: false } });
    const [row] = b.rows;
    expect(row).toMatchObject({ currency: 'INR', name: 'Indian rupee', receipts: 1, lastClose: { date: yesterday, closed: true } });
    expect(row.inverse).toBeCloseTo(75, 9);
    expect(row.change).toBeCloseTo(76 / 75 - 1, 9);
  });

  test("today's receipts take the live rate, then move to the close; a claimed one keeps its rate", async () => {
    await live.refresh(u.companyId);                                   // nothing watched yet: a no-op
    const open = expense('INR', 1000);
    const claimed = expense('INR', 1000);
    await live.refresh(u.companyId);
    await apply.applyFx(open.id); await apply.applyFx(claimed.id);
    expect(store.getExpense(open.id).baseTotal).toBe(13.33);             // 1000 / 75
    store.updateExpense(claimed.id, { claimedAt: new Date().toISOString() });

    providers.frankfurterAll.mockResolvedValue(ecb({ INR: 74 }));      // the rupee firms before the close
    const out = await live.close(u.companyId, today);
    expect(out.closed).toEqual(['INR']);
    expect(out.repriced).toEqual({ looked: 1, changed: 1 });
    expect(store.getExpense(open.id).baseTotal).toBe(13.51);             // 1000 / 74
    expect(store.getExpense(claimed.id).baseTotal).toBe(13.33);
    expect(live.closedOn(u.companyId, today)).toBe(true);

    // A closed day keeps its price, even against a forced refresh.
    providers.frankfurter.mockResolvedValue({ rate: 0.02, providerDate: today, source: 'frankfurter' });
    const again = await rates.getRate({ from: 'INR', to: 'SGD', date: today, force: true, today });
    expect(again.rate).toBeCloseTo(1 / 74, 12);
    expect(again.closedAt).toBeTruthy();
    expect(providers.frankfurter).not.toHaveBeenCalled();
  });

  test('a day the server missed is closed late from its history, never from today\'s live rate', async () => {
    expense('INR', 1000);
    await live.refresh(u.companyId);
    providers.frankfurter.mockResolvedValue({ rate: 0.0133, providerDate: yesterday, source: 'frankfurter' });
    const out = await live.close(u.companyId, yesterday);
    expect(out.closed).toEqual(['INR']);
    const row = rates.history('INR', 'SGD').find(e => e.date === yesterday);
    expect(row).toMatchObject({ rate: 0.0133, source: 'frankfurter' });
    expect(row.closedAt).toBeTruthy();
  });

  test('a currency added mid-day takes yesterday\'s rate as its last close, once', async () => {
    live.watch(u.companyId, 'MYR');
    await live.refresh(u.companyId);
    providers.frankfurter.mockResolvedValue({ rate: 0.3125, providerDate: yesterday, source: 'frankfurter' });
    await live.backfill(u.companyId, 'MYR');
    const [row] = live.board(u.companyId).rows;
    expect(row.lastClose).toMatchObject({ date: yesterday, rate: 0.3125, closed: true });
    expect(row.change).toBeCloseTo((1 / 3.2) / 0.3125 - 1, 9);
    expect(await live.backfill(u.companyId, 'MYR')).toBeNull();
    expect(providers.frankfurter).toHaveBeenCalledTimes(1);
  });

  test('a close that moved further than a currency moves is refused, not stored', async () => {
    expense('INR', 1000);
    rates.recordClose({ from: 'INR', to: 'SGD', date: yesterday, rate: 1 / 75, source: 'frankfurter', providerDate: yesterday });
    providers.frankfurterAll.mockResolvedValue(ecb({ INR: 50 }));      // a third stronger overnight
    const out = await live.close(u.companyId, today);
    expect(out.closed).toEqual([]);
    expect(out.blocked[0]).toMatchObject({ currency: 'INR', why: expect.stringMatching(/moved/) });
    expect(rates.history('INR', 'SGD').find(e => e.date === today)).toBeUndefined();
  });

  test('the schedule closes a missed yesterday, and today only from 23:55 company time', async () => {
    expense('INR', 1000);
    providers.frankfurter.mockResolvedValue({ rate: 0.0133, providerDate: yesterday, source: 'frankfurter' });
    const noon = new Date(`${today}T04:00:00Z`);                        // 12:00 in Singapore
    await live.tick(noon);
    expect(live.closedOn(u.companyId, yesterday)).toBe(true);
    expect(live.closedOn(u.companyId, today)).toBe(false);
    const late = new Date(`${today}T15:56:00Z`);                        // 23:56 in Singapore
    await live.tick(late);
    expect(live.closedOn(u.companyId, today)).toBe(true);
    const closes = db.prepare('SELECT COUNT(*) AS n FROM fx_closes').get().n;
    await live.tick(late);
    expect(db.prepare('SELECT COUNT(*) AS n FROM fx_closes').get().n).toBe(closes);   // not twice
  });

  test('the log is one line a day, newest first, with today live until the close and an admin rate over its provider figure', async () => {
    const e = expense('INR', 1000, { receiptDate: yesterday });
    rates.recordClose({ from: 'INR', to: 'SGD', date: yesterday, rate: 1 / 76, source: 'frankfurter', providerDate: yesterday });
    rates.setManualRate({ from: 'INR', to: 'SGD', date: yesterday, rate: 0.0135, by: 'a@solv.sg' });
    await apply.applyFx(e.id);
    await live.refresh(u.companyId);
    const log = live.log(u.companyId, 'INR');
    expect(log.entries.map(x => [x.date, x.kind])).toEqual([[today, 'live'], [yesterday, 'manual']]);
    expect(log.entries[1]).toMatchObject({ rate: 0.0135, enteredBy: 'a@solv.sg', usedBy: 1, overrides: { source: 'frankfurter' } });
    expect(log.entries[1].overrides.rate).toBeCloseTo(1 / 76, 12);
  });

  test('an Open Exchange Rates App ID is checked before it is kept, then leads, with the ECB as its check', async () => {
    expense('INR', 1000);
    providers.oxrAll.mockRejectedValueOnce(new Error('Open Exchange Rates: Invalid App ID provided'));
    await expect(live.setOxrKey(u.companyId, 'bad')).rejects.toThrow(/Invalid App ID/);
    expect(live.sourceInfo(u.companyId).keyed).toBe(false);

    const oxr = { source: 'openexchangerates', base: 'USD', providerDate: today, providerTime: `${today}T05:00:00.000Z`, rates: { SGD: 1.28, INR: 96.32 } };
    providers.oxrAll.mockResolvedValue(oxr);
    const info = await live.setOxrKey(u.companyId, 'abcd1234wxyz');
    expect(info).toMatchObject({ keyed: true, provider: 'openexchangerates', keyMasked: '••••wxyz' });
    expect(users.getCompanyConfig(u.companyId).FX_OXR_APP_ID).toBe('abcd1234wxyz');

    await live.refresh(u.companyId);
    const inr = rates.liveRate('INR', 'SGD');
    expect(inr).toMatchObject({ source: 'openexchangerates', providerTime: `${today}T05:00:00.000Z` });
    expect(inr.rate).toBeCloseTo(1.28 / 96.32, 12);
    expect(inr.divergence).toBeCloseTo((1.28 / 96.32) / (1 / 75) - 1, 9);

    // A failing key does not blank the board: the daily feeds carry on.
    providers.oxrAll.mockRejectedValue(new Error('Open Exchange Rates: quota exceeded'));
    live._lastRefresh.clear();
    const out = await live.refresh(u.companyId);
    expect(out).toMatchObject({ source: 'frankfurter', oxrError: expect.stringMatching(/quota/) });
    expect(rates.liveRate('INR', 'SGD').source).toBe('frankfurter');

    await live.setOxrKey(u.companyId, '');
    expect(live.sourceInfo(u.companyId).keyed).toBe(false);
  });
});
