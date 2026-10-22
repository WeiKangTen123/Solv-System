describe('store/policy', () => {
  let policy, users, db, company, admin;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    db = require('../db'); users = require('../store/users'); policy = require('./policy');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'Admin' });
    company = users.getCompany(admin.companyId);
  });
  const set = patch => policy.setPolicy(company.id, patch, null);
  const refused = (patch, message) => {
    let err = null;
    try { set(patch); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 400 });
    if (message) expect(err.message).toMatch(message);
  };

  test('a company that set nothing has the defaults: no rate, 100% travel days, no limits, no age, weekends fine', () => {
    expect(policy.getPolicy(company.id)).toEqual({ mileageRatePerKm: null, travelDayPct: 100, categoryLimits: {}, maxAgeDays: null, flagWeekends: false });
    expect(policy.getPolicy(null)).toEqual(policy.getPolicy(company.id));
    expect(policy.policyChange(company.id)).toEqual({ updatedAt: null, updatedBy: null });
  });

  test('only what is sent changes, and each value comes back clean', () => {
    policy.setPolicy(company.id, { mileageRatePerKm: '0.6', maxAgeDays: 90 }, admin.id);
    expect(policy.policyChange(company.id)).toMatchObject({ updatedAt: expect.any(String), updatedBy: { id: admin.id, name: 'Admin' } });
    set({ flagWeekends: true, travelDayPct: 75 });
    expect(policy.getPolicy(company.id)).toEqual({ mileageRatePerKm: 0.6, travelDayPct: 75, categoryLimits: {}, maxAgeDays: 90, flagWeekends: true });
    // empty takes a setting back to none, or to the default
    set({ mileageRatePerKm: null, maxAgeDays: '', travelDayPct: null });
    expect(policy.getPolicy(company.id)).toMatchObject({ mileageRatePerKm: null, maxAgeDays: null, travelDayPct: 100, flagWeekends: true });
  });

  test('category limits merge: a category spelt any way, null removes one, null for all clears them', () => {
    set({ categoryLimits: { meals: 50, 'Air & Transport': '120.505' } });
    expect(policy.getPolicy(company.id).categoryLimits).toEqual({ Meals: 50, 'Air & Transport': 120.51 });
    set({ categoryLimits: { Lodging: 0, Meals: null } });
    expect(policy.getPolicy(company.id).categoryLimits).toEqual({ 'Air & Transport': 120.51, Lodging: 0 });
    set({ categoryLimits: null });
    expect(policy.getPolicy(company.id).categoryLimits).toEqual({});
  });

  test('every setting is checked, and the refusal says what it takes', () => {
    refused({ maxAge: 30 }, /Unknown policy setting: maxAge\. The settings are mileageRatePerKm, travelDayPct, categoryLimits, maxAgeDays and flagWeekends/);
    refused([1], /as an object/);
    refused(null, /as an object/);
    for (const v of [0, -1, 100.01, 'abc', true, {}]) refused({ mileageRatePerKm: v }, /mileage rate/);
    for (const v of [-1, 101, 'x', false]) refused({ travelDayPct: v }, /percentage from 0 to 100/);
    for (const v of [0, 3651, 1.5, 'abc', true]) refused({ maxAgeDays: v }, /whole number of days from 1 to 3650/);
    for (const v of ['true', 1, null]) refused({ flagWeekends: v }, /true or false/);
    refused({ categoryLimits: { Snacks: 5 } }, /Not a category: Snacks/);
    refused({ categoryLimits: { Meals: -1 } }, /limit for Meals/);
    refused({ categoryLimits: { Meals: 'lots' } }, /limit for Meals/);
    refused({ categoryLimits: [5] }, /category and amount/);
    refused({ categoryLimits: 'Meals' }, /category and amount/);
    // nothing refused was half-saved
    expect(policy.getPolicy(company.id)).toEqual(policy.DEFAULTS);
  });

  test('the edges are allowed', () => {
    set({ mileageRatePerKm: 100, travelDayPct: 0, maxAgeDays: 3650 });
    set({ maxAgeDays: 1, travelDayPct: 100, mileageRatePerKm: 0.0001 });
    expect(policy.getPolicy(company.id)).toMatchObject({ mileageRatePerKm: 0.0001, travelDayPct: 100, maxAgeDays: 1 });
  });

  test('read once and kept, dropped on a write; what is handed out cannot be changed by the caller', () => {
    set({ maxAgeDays: 30 });
    const p = policy.getPolicy(company.id);
    expect(policy.getPolicy(company.id)).toBe(p);
    expect(() => { 'use strict'; p.categoryLimits.Meals = 1; }).toThrow();
    // a write somewhere else is not seen until the cache is dropped
    db.prepare('UPDATE company_policy SET json = ? WHERE company_id = ?').run(JSON.stringify({ maxAgeDays: 60 }), company.id);
    expect(policy.getPolicy(company.id).maxAgeDays).toBe(30);
    policy._clearCache();
    expect(policy.getPolicy(company.id).maxAgeDays).toBe(60);
    set({ flagWeekends: true });
    expect(policy.getPolicy(company.id)).toMatchObject({ maxAgeDays: 60, flagWeekends: true });
  });

  test('a row edited by hand keeps the default for whatever no longer reads', () => {
    db.prepare('INSERT INTO company_policy (company_id, json) VALUES (?, ?)').run(company.id, JSON.stringify({ maxAgeDays: 'soon', flagWeekends: true, categoryLimits: { Meals: 40, Nope: 3 }, extra: 1 }));
    expect(policy.getPolicy(company.id)).toEqual({ mileageRatePerKm: null, travelDayPct: 100, categoryLimits: {}, maxAgeDays: null, flagWeekends: true });
    policy._clearCache();
    db.prepare('UPDATE company_policy SET json = ? WHERE company_id = ?').run('not json', company.id);
    expect(policy.getPolicy(company.id)).toEqual(policy.DEFAULTS);
  });

  describe('per-diem rates', () => {
    const add = extra => policy.addRate({ companyId: company.id, country: 'in', currency: 'inr', dailyAmount: 4000, effectiveFrom: '2026-01-01', createdBy: 'u1', ...extra });

    test('added with the codes in capitals, listed by country with the newest first, deleted', () => {
      const a = add();
      expect(a).toMatchObject({ country: 'IN', countryName: 'India', currency: 'INR', dailyAmount: 4000, effectiveFrom: '2026-01-01', createdBy: 'u1' });
      const b = add({ dailyAmount: '4500.5', effectiveFrom: '2026-10-01' });
      const c = add({ country: 'MY', currency: 'MYR', dailyAmount: 150 });
      expect(policy.listRates(company.id).map(r => r.id)).toEqual([b.id, a.id, c.id]);
      expect(b.dailyAmount).toBe(4500.5);
      expect(policy.deleteRate(company.id, a.id)).toBe(true);
      expect(policy.deleteRate(company.id, a.id)).toBe(false);
      expect(policy.deleteRate('another-company', b.id)).toBe(false);
      expect(policy.listRates(company.id)).toHaveLength(2);
    });

    test('the rate for a day is the latest that had started by then', () => {
      add(); add({ dailyAmount: 4500, effectiveFrom: '2026-10-01' });
      expect(policy.rateFor(company.id, 'IN', '2025-12-31')).toBeNull();
      expect(policy.rateFor(company.id, 'IN', '2026-01-01').dailyAmount).toBe(4000);
      expect(policy.rateFor(company.id, 'in', '2026-09-30').dailyAmount).toBe(4000);
      expect(policy.rateFor(company.id, 'IN', '2026-10-01').dailyAmount).toBe(4500);
      expect(policy.rateFor(company.id, 'IN', '2030-01-01').dailyAmount).toBe(4500);
      expect(policy.rateFor(company.id, 'LK', '2026-10-01')).toBeNull();
      expect(policy.rateFor('another-company', 'IN', '2026-10-01')).toBeNull();
    });

    test('every field is checked, and one day has one rate', () => {
      const bad = (extra, status, message) => {
        let err = null;
        try { add(extra); } catch (e) { err = e; }
        expect(err).toMatchObject({ status });
        expect(err.message).toMatch(message);
      };
      for (const country of ['IND', 'I', 'ZZ', '', 5, null]) bad({ country }, 400, /two-letter country code/);
      for (const currency of ['RS', 'INRS', 'R$1', '', null]) bad({ currency }, 400, /three-letter code/);
      for (const dailyAmount of [0, -5, 'abc', '', null, 0.001, 1e9]) bad({ dailyAmount }, 400, /above 0/);
      for (const effectiveFrom of ['2026-02-30', '01/01/2026', '', null, 20260101]) bad({ effectiveFrom }, 400, /YYYY-MM-DD/);
      add();
      bad({ dailyAmount: 5000 }, 409, /already a rate for India from 1 Jan 2026/);
    });
  });
});
