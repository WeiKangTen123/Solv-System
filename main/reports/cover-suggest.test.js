const { suggestCover, countryName, monthSpan, dayRange } = require('./cover-suggest');

// A read receipt as the case page holds it. Only what the suggestion reads.
const r = (receiptDate, extra = {}) => ({ status: 'review-needed', receiptDate, currency: 'SGD', country: null, city: null, docType: null, ...extra });
const opts = { baseCurrency: 'SGD', today: '2026-10-21' };

describe('reports/cover-suggest', () => {
  test('a trip abroad: the dates, the nights, the three busiest towns and the country', () => {
    const s = suggestCover([
      r('2026-08-31', { merchant: 'Grab', city: 'Singapore', country: 'SG' }),
      r('2026-09-01', { currency: 'INR', city: 'Mumbai', country: 'IN', docType: 'hotel' }),
      r('2026-09-02', { currency: 'INR', city: 'Pune', country: 'IN' }),
      r('2026-09-03', { currency: 'INR', city: 'mumbai', country: 'IN' }),
      r('2026-09-03', { currency: 'INR', city: 'Chakan', country: 'IN' }),
      r('2026-09-04', { currency: 'INR', city: 'Pune' }),
      r('2026-09-04', { currency: 'INR', city: 'Lonavala', country: 'IN' }),
    ], opts);
    expect(s).toMatchObject({ kind: 'trip', title: 'India trip, Aug–Sep 2026', periodFrom: '2026-08-31', periodTo: '2026-09-04', nights: 4,
                              destination: 'Mumbai, Pune, Chakan, India' });
    expect(s.basis).toMatchObject({ receipts: 7, foreign: 6, travel: 1, countries: ['IN'], why: 'foreign' });
  });

  test('every receipt at home in one month is that month', () => {
    const s = suggestCover([r('2026-10-03'), r('2026-10-18', { city: 'Singapore', country: 'SG' }), r('2026-10-09')], opts);
    expect(s).toEqual({ kind: 'period', title: 'October 2026 claims', periodFrom: '2026-10-01', periodTo: '2026-10-31', destination: null, nights: null,
                        basis: { receipts: 3, foreign: 0, travel: 0, countries: [], why: 'month' } });
    expect(suggestCover([r('2028-02-10')], { ...opts, today: '2028-03-01' })).toMatchObject({ periodFrom: '2028-02-01', periodTo: '2028-02-29' });
  });

  test('receipts at home across months are a case from the first to the last', () => {
    const s = suggestCover([r('2026-10-18'), r('2026-09-03'), r('2026-09-20')], opts);
    expect(s).toMatchObject({ kind: 'case', title: 'Receipts, 3 Sep – 18 Oct 2026', periodFrom: '2026-09-03', periodTo: '2026-10-18', destination: null, nights: null });
    expect(suggestCover([r('2025-12-28'), r('2026-01-03')], opts).title).toBe('Receipts, 28 Dec 2025 – 3 Jan 2026');
  });

  test('two countries are both named; three or more make it a trip with no country in the title', () => {
    const two = suggestCover([
      r('2026-09-01', { currency: 'INR', city: 'Mumbai', country: 'IN' }),
      r('2026-09-02', { currency: 'INR', city: 'Pune', country: 'IN' }),
      r('2026-09-05', { currency: 'LKR', city: 'Colombo', country: 'LK' }),
    ], opts);
    expect(two).toMatchObject({ kind: 'trip', title: 'India and Sri Lanka trip, Sep 2026', destination: 'India, Sri Lanka', nights: 4 });
    const three = suggestCover([
      r('2026-09-28', { currency: 'INR', country: 'IN' }), r('2026-10-01', { currency: 'LKR', country: 'LK' }), r('2026-10-02', { currency: 'THB' }),
    ], opts);
    expect(three).toMatchObject({ title: 'Trip, Sep–Oct 2026', destination: 'India, Sri Lanka, Thailand' });
  });

  test('a foreign currency with no address is that currency\'s country; the euro is nobody\'s', () => {
    expect(suggestCover([r('2026-09-10', { currency: 'USD' })], opts)).toMatchObject({ kind: 'trip', title: 'United States trip, Sep 2026', destination: 'United States', nights: 0 });
    expect(suggestCover([r('2026-09-10', { currency: 'HKD', city: 'Hong Kong' })], opts)).toMatchObject({ title: 'Hong Kong trip, Sep 2026', destination: 'Hong Kong' });
    expect(suggestCover([r('2026-09-10', { currency: 'EUR' })], opts)).toMatchObject({ kind: 'trip', title: 'Trip, Sep 2026', destination: null });
    expect(suggestCover([r('2026-09-10', { currency: 'EUR', city: 'Lyon' })], opts)).toMatchObject({ title: 'Trip, Sep 2026', destination: 'Lyon' });
  });

  test('a hotel at home is still a trip, named by where the hotel was', () => {
    const s = suggestCover([r('2026-09-10', { docType: 'hotel', city: 'Sentosa', country: 'SG' }), r('2026-09-12', { city: 'Jurong' })], opts);
    expect(s).toMatchObject({ kind: 'trip', title: 'Trip, Sep 2026', destination: 'Sentosa', nights: 2 });
    expect(s.basis.why).toBe('travel');
  });

  test('home is the base currency\'s country, so a Malaysian company in Singapore is abroad', () => {
    const s = suggestCover([r('2026-09-10', { currency: 'SGD', city: 'Singapore', country: 'SG' }), r('2026-09-11', { currency: 'MYR', country: 'MY' })],
      { baseCurrency: 'MYR', today: '2026-10-21' });
    expect(s).toMatchObject({ kind: 'trip', title: 'Singapore trip, Sep 2026', destination: 'Singapore' });
    // a base currency it does not know is taken as Singapore's
    expect(suggestCover([r('2026-09-10', { currency: 'XAF' })], { baseCurrency: 'XAF' }).basis.why).toBe('month');
  });

  test('nothing read and dated is no suggestion at all', () => {
    expect(suggestCover([], opts)).toBeNull();
    expect(suggestCover(null, opts)).toBeNull();
    expect(suggestCover([r(null), r(''), r('2026-13'), r('2026-09-04', { status: 'reading' })], opts)).toBeNull();
  });

  test('duplicates, rejected and future-dated receipts are left out', () => {
    const s = suggestCover([
      r('2026-09-04'), r('2026-09-10'),
      r('2026-01-01', { status: 'duplicate', currency: 'INR', country: 'IN' }),
      r('2026-02-01', { status: 'rejected' }),
      r('2027-09-04'),   // a misread year
    ], opts);
    expect(s).toMatchObject({ kind: 'period', periodFrom: '2026-09-01', periodTo: '2026-09-30' });
    expect(s.basis.receipts).toBe(2);
  });

  test('the purpose is never suggested', () => {
    for (const list of [[r('2026-09-04', { currency: 'INR', country: 'IN', purpose: 'Client visit' })], [r('2026-10-01')], [r('2026-09-01'), r('2026-10-01')]]) {
      expect(suggestCover(list, opts)).not.toHaveProperty('purpose');
    }
  });

  test('names and spans as a person writes them', () => {
    expect(countryName('IN')).toBe('India');
    expect(countryName('mo')).toBe('Macao');
    expect(countryName('XX')).toBeNull();
    expect(countryName('India')).toBeNull();
    expect(monthSpan('2026-12-28', '2027-01-03')).toBe('Dec 2026–Jan 2027');
    expect(dayRange('2026-09-01', '2026-09-04')).toBe('1–4 Sep 2026');
    expect(dayRange('2026-09-04', '2026-09-04')).toBe('4 Sep 2026');
    expect(dayRange('2026-09-28', '2026-10-02')).toBe('28 Sep – 2 Oct 2026');
  });
});

describe('reports/cover-suggest findMatch', () => {
  let store, reports, users, cs, u, v;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports'); cs = require('./cover-suggest');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
    v = await users.createUser({ email: 'v@solv.sg', password: 'password123', companyId: u.companyId });
  });
  const kase = (owner, periodFrom, periodTo, extra = {}) => reports.createReport({ companyId: owner.companyId, userId: owner.id, title: `${periodFrom}`, periodFrom, periodTo, ...extra });
  const put = (c, receiptDate, extra = {}) => reports.addExpense(c.id, store.createExpense({ companyId: c.companyId, userId: c.userId, status: 'review-needed', receiptDate, ...extra }).id);

  test('the narrowest open case of the owner that holds every dated receipt', () => {
    const month = kase(u, '2026-09-01', '2026-09-30');
    const week = kase(u, '2026-09-01', '2026-09-10');
    const narrowButClaimed = kase(u, '2026-09-02', '2026-09-05');
    require('../db').prepare("UPDATE expense_reports SET status = 'claimed' WHERE id = ?").run(narrowButClaimed.id);
    kase(v, '2026-09-02', '2026-09-05');                                 // somebody else's
    kase(u, '2026-09-02', '2026-09-05', { draft: true });                // a draft is not offered
    kase(u, null, null);                                                 // no dates, holds nothing
    const draft = reports.createReport({ companyId: u.companyId, userId: u.id, draft: true });
    put(draft, '2026-09-02'); put(draft, '2026-09-05'); put(draft, null);
    put(draft, '2026-12-31', { status: 'duplicate' });                   // a duplicate does not count
    put(draft, '2026-12-30', { status: 'reading' });                     // nor one still being read
    expect(cs.findMatch(draft.id, u.id)).toEqual({ id: week.id, number: week.number, title: week.title, periodFrom: '2026-09-01', periodTo: '2026-09-10' });
    put(draft, '2026-09-20');
    expect(cs.findMatch(draft.id, u.id).id).toBe(month.id);
    put(draft, '2026-10-01');
    expect(cs.findMatch(draft.id, u.id)).toBeNull();
  });

  test('a case with no dated receipt matches nothing', () => {
    kase(u, '2026-01-01', '2026-12-31');
    const draft = reports.createReport({ companyId: u.companyId, userId: u.id, draft: true });
    expect(cs.findMatch(draft.id, u.id)).toBeNull();
    put(draft, null);
    expect(cs.findMatch(draft.id, u.id)).toBeNull();
    expect(cs.findMatch(null, u.id)).toBeNull();
  });
});
