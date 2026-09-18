jest.mock('./providers', () => ({ frankfurter: jest.fn(), erapi: jest.fn() }));

describe('fx/rates', () => {
  let rates, providers, db;
  beforeEach(() => { jest.resetModules(); db = require('../db'); require('../db/migrate').run(); rates = require('./rates'); providers = require('./providers'); providers.frankfurter.mockReset(); providers.erapi.mockReset(); });

  test('same currency is rate 1 with no provider call', async () => {
    expect(await rates.getRate({ from: 'SGD', to: 'SGD', date: '2026-09-04' })).toMatchObject({ rate: 1, source: 'same' });
    expect(providers.frankfurter).not.toHaveBeenCalled();
  });

  test('a historical rate is fetched once, cached, and served from the cache after', async () => {
    providers.frankfurter.mockResolvedValue({ rate: 0.01341, providerDate: '2026-09-04', source: 'frankfurter' });
    const a = await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-06' });
    expect(a).toMatchObject({ rate: 0.01341, rateDate: '2026-09-06', providerDate: '2026-09-04', source: 'frankfurter' });
    expect(a.fetchedAt).toBeTruthy();
    const b = await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-06' });
    expect(b.rate).toBe(0.01341);
    expect(providers.frankfurter).toHaveBeenCalledTimes(1);
  });

  test('falls back to open.er-api when frankfurter has no such currency, and to null when nobody does', async () => {
    providers.frankfurter.mockResolvedValue(null);
    providers.erapi.mockResolvedValue({ rate: 0.0000528, providerDate: '2026-09-17', source: 'open.er-api' });
    expect(await rates.getRate({ from: 'VND', to: 'SGD', date: '2026-09-04' })).toMatchObject({ rate: 0.0000528, source: 'open.er-api' });
    providers.erapi.mockResolvedValue(null);
    expect(await rates.getRate({ from: 'ZZZ', to: 'SGD', date: '2026-09-04' })).toBeNull();
  });

  test('a manual rate beats a provider rate for the same day', async () => {
    providers.frankfurter.mockResolvedValue({ rate: 0.01341, providerDate: '2026-09-04', source: 'frankfurter' });
    await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-04' });
    rates.setManualRate({ from: 'INR', to: 'SGD', date: '2026-09-04', rate: 0.0135, by: 'finance@solv.sg' });
    expect(await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-04' })).toMatchObject({ rate: 0.0135, source: 'manual', enteredBy: 'finance@solv.sg' });
    expect(rates.listRates({ to: 'SGD' })).toHaveLength(2);
    expect(rates.deleteManualRate({ from: 'INR', to: 'SGD', date: '2026-09-04' })).toBe(true);
    expect((await rates.getRate({ from: 'INR', to: 'SGD', date: '2026-09-04' })).source).toBe('frankfurter');
  });

  test("today's rate is refreshed after an hour, older days never", async () => {
    const today = new Date().toISOString().slice(0, 10);
    providers.frankfurter.mockResolvedValueOnce({ rate: 0.0132, providerDate: today, source: 'frankfurter' });
    await rates.getRate({ from: 'INR', to: 'SGD', date: today });
    db.prepare("UPDATE fx_rates SET fetched_at = ? WHERE source = 'frankfurter'").run(new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    providers.frankfurter.mockResolvedValueOnce({ rate: 0.0133, providerDate: today, source: 'frankfurter' });
    expect((await rates.getRate({ from: 'INR', to: 'SGD', date: today })).rate).toBe(0.0133);
    expect(providers.frankfurter).toHaveBeenCalledTimes(2);
  });

  test('a date in the future is priced at latest', async () => {
    providers.frankfurter.mockResolvedValue({ rate: 0.0132, providerDate: '2026-09-16', source: 'frankfurter' });
    await rates.getRate({ from: 'INR', to: 'SGD', date: '2099-01-01' });
    expect(providers.frankfurter).toHaveBeenCalledWith('INR', 'SGD', null);
  });
});
