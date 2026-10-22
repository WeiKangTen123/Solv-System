describe('reports/allowances', () => {
  let allowances, policy, company;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    const users = require('../store/users');
    policy = require('../store/policy'); allowances = require('./allowances');
    company = users.getCompany((await users.createUser({ email: 'a@solv.sg', password: 'password123' })).companyId);
    policy.addRate({ companyId: company.id, country: 'IN', currency: 'INR', dailyAmount: 4000, effectiveFrom: '2026-01-01' });
  });
  const plan = (from, to, travelDayPct = 100, country = 'IN') => allowances.perDiemPlan({ companyId: company.id, country, from, to, travelDayPct });
  const refusal = fn => { try { fn(); } catch (err) { return err; } return null; };

  describe('perDiemPlan', () => {
    test('days × the rate, the first and last day at the travel-day share', () => {
      expect(plan('2026-09-01', '2026-09-04', 75)).toEqual({ country: 'IN', countryName: 'India', currency: 'INR', total: 14000, days: 4,
        description: 'Per diem, India: 4 days (first and last at 75%) × INR 4,000' });
      expect(plan('2026-09-01', '2026-09-04')).toMatchObject({ total: 16000, description: 'Per diem, India: 4 days × INR 4,000' });
      // two days are both travel days; three leave one whole day between
      expect(plan('2026-09-01', '2026-09-02', 50).total).toBe(4000);
      expect(plan('2026-09-01', '2026-09-03', 0).total).toBe(4000);
      expect(plan('2026-09-01', '2026-09-03', 66.67).total).toBe(9333.6);
    });

    test('a one-day trip is that day at the share, once', () => {
      expect(plan('2026-09-01', '2026-09-01', 75)).toMatchObject({ total: 3000, days: 1, description: 'Per diem, India: 1 day at 75% × INR 4,000' });
      expect(plan('2026-09-01', '2026-09-01')).toMatchObject({ total: 4000, description: 'Per diem, India: 1 day × INR 4,000' });
    });

    test('a rate that changes mid-trip prices each day at its own rate, and says so', () => {
      policy.addRate({ companyId: company.id, country: 'IN', currency: 'INR', dailyAmount: 4500, effectiveFrom: '2026-09-03' });
      // 4,000 × 0.75 + 4,000 + 4,500 + 4,500 × 0.75
      expect(plan('2026-09-01', '2026-09-04', 75)).toMatchObject({ total: 14875,
        description: 'Per diem, India: 4 days (first and last at 75%) × INR 4,000 (1–2 Sep 2026), 4,500 (3–4 Sep 2026)' });
    });

    test('says why when it cannot: no rate, a trip that starts before the first, two currencies, nothing to pay, dates the wrong way', () => {
      expect(refusal(() => plan('2026-09-01', '2026-09-04', 100, 'LK'))).toMatchObject({ status: 400, message: 'There is no per-diem rate for Sri Lanka. An admin adds per-diem rates in Settings.' });
      expect(refusal(() => plan('2025-12-30', '2026-01-02')).message).toBe('The per-diem rate for India starts on 1 Jan 2026, after this trip\'s first day (30 Dec 2025). An admin can add an earlier rate in Settings.');
      policy.addRate({ companyId: company.id, country: 'IN', currency: 'USD', dailyAmount: 60, effectiveFrom: '2026-09-03' });
      expect(refusal(() => plan('2026-09-01', '2026-09-04')).message).toMatch(/rates for India during this trip are in INR and USD/);
      expect(plan('2026-09-03', '2026-09-04')).toMatchObject({ currency: 'USD', total: 120 });
      expect(refusal(() => plan('2026-08-01', '2026-08-02', 0)).message).toMatch(/first and last day at 0%, a trip of 2 days has no per diem/);
      expect(refusal(() => plan('2026-08-02', '2026-08-01')).message).toMatch(/ends before it starts/);
      expect(refusal(() => plan('2026-01-01', '2027-01-02')).message).toMatch(/at most 366 days, and this trip is 367/);
    });
  });

  describe('perDiemCountry', () => {
    const r = (expenses, destination = null) => ({ destination, expenses: expenses.map(e => ({ status: 'reviewed', source: 'upload', currency: 'SGD', country: null, ...e })) });

    test('where most foreign receipts were printed; home never counts', () => {
      expect(allowances.perDiemCountry(r([{ country: 'LK' }, { country: 'in' }, { country: 'IN' }, { country: 'SG' }, { country: 'SG' }, { country: 'SG' }]), 'SGD')).toBe('IN');
      expect(allowances.perDiemCountry(r([{ country: 'LK' }, { country: 'IN' }]), 'SGD')).toBe('LK');   // a tie goes to the first
    });

    test('then the country of a foreign currency, then a country named in the destination', () => {
      expect(allowances.perDiemCountry(r([{ currency: 'INR' }, { currency: 'EUR' }]), 'SGD')).toBe('IN');
      expect(allowances.perDiemCountry(r([{ currency: 'SGD' }], 'Pune, India'), 'SGD')).toBe('IN');
      expect(allowances.perDiemCountry(r([], 'Colombo; sri lanka'), 'SGD')).toBe('LK');
      expect(allowances.perDiemCountry(r([{ currency: 'SGD', country: 'SG' }], 'Head office'), 'SGD')).toBeNull();
      expect(allowances.perDiemCountry(r([]), 'SGD')).toBeNull();
    });

    test('the per diem and mileage rows, and receipts not yet read or left out, say nothing about where the trip was', () => {
      const list = [{ source: 'per_diem', country: 'LK', currency: 'LKR' }, { source: 'mileage', currency: 'MYR' }, { status: 'reading', country: 'TH' }, { status: 'duplicate', country: 'TH' }, { country: 'IN' }];
      expect(allowances.perDiemCountry(r(list), 'SGD')).toBe('IN');
    });

    test('home follows the base currency', () => {
      expect(allowances.perDiemCountry(r([{ country: 'MY' }, { country: 'SG' }]), 'MYR')).toBe('SG');
    });
  });
});
