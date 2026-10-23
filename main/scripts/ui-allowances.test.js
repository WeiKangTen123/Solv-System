const fs   = require('fs');
const path = require('path');

// What the case page's "Add per diem" and "Add mileage" dialogs show before
// they ask (ui/src/utils/allowances.js) against what the server then adds
// (main/reports/allowances.js). The dialog shows a total from the same rates
// and sends the country it shows; a preview that disagreed with the server
// would be a promise the claim then breaks. So each case is put to both.
//
// The UI file is an ES module and jest here runs CommonJS, so it is loaded
// from its source with its `export` keywords taken off, which only works
// while it imports nothing (its header says so).
const FILE = path.join(__dirname, '../../ui/src/utils/allowances.js');
function loadUi() {
  const src = fs.readFileSync(FILE, 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('utils/allowances.js imports something now; this test can only load a module that does not');
  const body = src.replace(/^export\s+(?=(async\s+function|function|const|let|class)\s)/gm, '');
  return new Function(`${body}\nreturn { allowanceOf, allowanceWords, countryName, countryOptions, currencyOf, guessPerDiemCountry, rateOn, perDiemPreview, mileagePreview, nameFlags, nameCaseFlags, dayCount, addDays };`)();
}
const A = loadUi();

describe('the per diem the dialog shows is the one the server adds', () => {
  let allowances, policy, company;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    const users = require('../store/users');
    policy = require('../store/policy'); allowances = require('../reports/allowances');
    company = users.getCompany((await users.createUser({ email: 'ui-allowances@solv.sg', password: 'password123' })).companyId);
    policy.addRate({ companyId: company.id, country: 'IN', currency: 'INR', dailyAmount: 4000, effectiveFrom: '2026-01-01' });
  });
  const both = (from, to, travelDayPct = 100, country = 'IN') => {
    let server;
    try { server = allowances.perDiemPlan({ companyId: company.id, country, from, to, travelDayPct }); }
    catch (err) { server = { problem: err.message }; }
    const ui = A.perDiemPreview({ rates: policy.listRates(company.id), country, from, to, travelDayPct });
    return { server, ui };
  };
  const same = (...args) => {
    const { server, ui } = both(...args);
    if (server.problem) expect(ui.problem).toBe(server.problem);
    else expect({ total: ui.total, currency: ui.currency, days: ui.days }).toEqual({ total: server.total, currency: server.currency, days: server.days });
    return ui;
  };

  test('days × the rate, the first and last at the travel-day share, a one-day trip at it once', () => {
    expect(same('2026-09-01', '2026-09-04', 75)).toMatchObject({ total: 14000, share: 75, runs: [{ amount: 4000, days: 4 }] });
    same('2026-09-01', '2026-09-04');
    same('2026-09-01', '2026-09-02', 50);
    same('2026-09-01', '2026-09-03', 0);
    same('2026-09-01', '2026-09-03', 66.67);
    same('2026-09-01', '2026-09-01', 75);
  });

  test('a rate that changes mid-trip: each day at its own, and the runs say which days', () => {
    policy.addRate({ companyId: company.id, country: 'IN', currency: 'INR', dailyAmount: 4500, effectiveFrom: '2026-09-03' });
    const ui = same('2026-09-01', '2026-09-04', 75);
    expect(ui.total).toBe(14875);
    expect(ui.runs).toEqual([{ amount: 4000, from: '2026-09-01', to: '2026-09-02', days: 2 }, { amount: 4500, from: '2026-09-03', to: '2026-09-04', days: 2 }]);
  });

  test('says why it cannot, in the server\'s words', () => {
    same('2026-09-01', '2026-09-04', 100, 'LK');
    same('2025-12-30', '2026-01-02');
    same('2026-08-01', '2026-08-02', 0);
    same('2026-08-02', '2026-08-01');
    same('2026-01-01', '2027-01-02');
    policy.addRate({ companyId: company.id, country: 'IN', currency: 'USD', dailyAmount: 60, effectiveFrom: '2026-09-03' });
    same('2026-09-01', '2026-09-04');
    same('2026-09-03', '2026-09-04');
  });

  test('the country it guesses is the server\'s', () => {
    const r = (expenses, destination = null) => ({ destination, expenses: expenses.map(e => ({ status: 'reviewed', source: 'upload', currency: 'SGD', country: null, ...e })) });
    const cases = [
      [r([{ country: 'LK' }, { country: 'in' }, { country: 'IN' }, { country: 'SG' }, { country: 'SG' }]), 'SGD'],
      [r([{ country: 'LK' }, { country: 'IN' }]), 'SGD'],
      [r([{ currency: 'INR' }, { currency: 'EUR' }]), 'SGD'],
      [r([{ currency: 'SGD' }], 'Pune, India'), 'SGD'],
      [r([], 'Colombo; sri lanka'), 'SGD'],
      [r([{ currency: 'SGD', country: 'SG' }], 'Head office'), 'SGD'],
      [r([]), 'SGD'],
      [r([{ source: 'per_diem', country: 'LK', currency: 'LKR' }, { source: 'mileage', currency: 'MYR' }, { status: 'reading', country: 'TH' }, { country: 'IN' }]), 'SGD'],
      [r([{ country: 'MY' }, { country: 'SG' }]), 'MYR'],
    ];
    for (const [report, base] of cases) expect(A.guessPerDiemCountry(report, base)).toBe(allowances.perDiemCountry(report, base));
  });
});

describe('mileage, as the server rounds it', () => {
  test('km × the rate, twice for a return trip; nothing until there is a distance and a rate', () => {
    expect(A.mileagePreview({ km: 12.345, returnTrip: false, rate: 0.6 })).toEqual({ km: 12.35, legs: 1, total: 7.41 });
    expect(A.mileagePreview({ km: '42', returnTrip: true, rate: 0.585 })).toEqual({ km: 42, legs: 2, total: 49.14 });
    expect(A.mileagePreview({ km: '', rate: 0.6 })).toBeNull();
    expect(A.mileagePreview({ km: 10, rate: null })).toBeNull();
  });
});

describe('a receipt-less row on screen', () => {
  test('is known by its source, and said by its description without the label it starts with', () => {
    expect(A.allowanceOf({ source: 'per_diem' })).toBe('per_diem');
    expect(A.allowanceOf({ source: 'mileage' })).toBe('mileage');
    expect(A.allowanceOf({ source: 'email' })).toBeNull();
    expect(A.allowanceOf(null)).toBeNull();
    expect(A.allowanceWords({ description: 'Per diem, India: 4 days × INR 4,000' })).toBe('India: 4 days × INR 4,000');
    expect(A.allowanceWords({ description: 'From Office to Tuas and back, 2 × 12 km × SGD 0.60' })).toBe('From Office to Tuas and back, 2 × 12 km × SGD 0.60');
  });

  test('a meal on a per-diem day names the per diem when the case is in hand', () => {
    const flags = [{ code: 'per-diem-meal', level: 'yellow', text: 'The case\'s per diem already pays for meals on this day.', field: 'category' }, { code: 'weekend', level: 'yellow', text: 'It is dated on a Saturday.' }];
    const list = [{ id: 'p', source: 'per_diem', country: 'IN' }, { id: 'm', source: 'upload', flags }];
    expect(A.nameFlags(flags, list)[0].text).toBe('The per diem for India in this case already pays for meals on this day.');
    expect(A.nameFlags(flags, list)[1]).toBe(flags[1]);
    // No per diem to name: the server's words stand.
    expect(A.nameFlags(flags, [list[1]])).toBe(flags);
    const view = A.nameCaseFlags({ report: { expenses: list } });
    expect(view.report.expenses[1].flags[0].text).toMatch(/per diem for India/);
  });

  test('countries by the names the server uses, with the currency a rate is usually in', () => {
    expect(A.countryName('in')).toBe('India');
    expect(A.countryName('HK')).toBe('Hong Kong');
    expect(A.countryName('ZZ')).toBeNull();
    expect(A.countryName('India')).toBeNull();
    const opts = A.countryOptions();
    expect(opts.length).toBeGreaterThan(200);
    expect(opts.find(o => o.code === 'IN')).toEqual({ code: 'IN', name: 'India' });
    expect(opts.some(o => o.code === 'EU' || o.code === 'UN')).toBe(false);
    expect(A.currencyOf('IN')).toBe('INR');
    expect(A.currencyOf('de')).toBe('EUR');
    expect(A.currencyOf('AQ')).toBe('');
  });
});
