describe('reports/cover-help', () => {
  let store, reports, users, help, auto, u, other;
  const opts = { baseCurrency: 'SGD', today: '2026-10-28' };
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports');
    help = require('./cover-help'); auto = require('./cover-auto');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: u.companyId });
  });
  const open = (extra = {}) => reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Typed', ...extra });
  const draft = () => reports.createReport({ companyId: u.companyId, userId: u.id, draft: true });
  const put = (c, receiptDate, extra = {}) => reports.addExpense(c.id, store.createExpense({ companyId: u.companyId, userId: u.id, status: 'review-needed', receiptDate, currency: 'SGD', ...extra }).id);
  const get = c => reports.getReport(c.id);
  const india = (c, d, city, docType = null, category = 'Meals') => put(c, d, { currency: 'INR', country: 'IN', city, docType, lines: [{ category, amount: 100 }] });

  describe('caseSuggestion', () => {
    test('a draft gets the whole cover the receipts suggest; once created, the kind its owner chose', () => {
      const d = draft();
      india(d, '2026-09-01', 'Mumbai', 'hotel', 'Lodging'); india(d, '2026-09-04', 'Pune');
      expect(help.caseSuggestion(get(d), opts)).toMatchObject({ kind: 'trip', title: 'India trip, Sep 2026', periodFrom: '2026-09-01', periodTo: '2026-09-04',
                                                                 destination: 'Mumbai, Pune, India', nights: 3 });
      reports.openDraft(d.id, { kind: 'case', title: 'Chakan job' }, u.id);
      expect(help.caseSuggestion(get(d), opts)).toMatchObject({ kind: 'case', title: 'Receipts, 1–4 Sep 2026', periodFrom: '2026-09-01', periodTo: '2026-09-04' });
    });

    // The investigation's first example: the receipts of a Trip happened to
    // be local, and the open case was offered "Month" and a whole month.
    test('a Trip with typed 3–5 Sep and local receipts is offered a trip, not a Month', () => {
      const t = open({ kind: 'trip', periodFrom: '2026-09-03', periodTo: '2026-09-05' });
      put(t, '2026-09-03', { city: 'Singapore' }); put(t, '2026-09-04'); put(t, '2026-09-05');
      const s = help.caseSuggestion(get(t), opts);
      expect(s).toMatchObject({ kind: 'trip', title: 'Trip, Sep 2026', periodFrom: '2026-09-03', periodTo: '2026-09-05', nights: 2 });
      expect(require('./cover-suggest').suggestCover(get(t).expenses, opts).kind).toBe('period');     // what it used to be offered
    });

    // The second: one receipt from seven weeks later offered 49 nights.
    test('a stray receipt dated 20 Oct does not stretch the dates or offer 49 nights; one beside them does widen them', () => {
      const t = open({ kind: 'trip', periodFrom: '2026-09-01', periodTo: '2026-09-04' });
      india(t, '2026-09-01', 'Mumbai'); india(t, '2026-09-04', 'Pune');
      put(t, '2026-10-20', { currency: 'THB', country: 'TH', city: 'Bangkok' });
      expect(help.caseSuggestion(get(t), opts)).toMatchObject({ periodFrom: '2026-09-01', periodTo: '2026-09-04', nights: 3, destination: 'Mumbai, Pune, India',
                                                                 title: 'India trip, Sep 2026' });
      india(t, '2026-09-06', 'Mumbai');                                    // the taxi home two days after
      expect(help.caseSuggestion(get(t), opts)).toMatchObject({ periodFrom: '2026-09-01', periodTo: '2026-09-06', nights: 5 });
      india(t, '2026-08-29', 'Mumbai');                                    // and the airport three days before
      expect(help.caseSuggestion(get(t), opts)).toMatchObject({ periodFrom: '2026-08-29', periodTo: '2026-09-06', nights: 8, title: 'India trip, Aug–Sep 2026' });
    });

    test('nights come from the dates; an undated trip takes its receipts\' first and last day', () => {
      const t = open({ kind: 'trip' });
      india(t, '2026-09-02', 'Pune'); india(t, '2026-09-07', 'Pune');
      put(t, '2026-09-30', { source: 'mileage', status: 'reviewed' });     // a drive dates nothing
      expect(help.caseSuggestion(get(t), opts)).toMatchObject({ periodFrom: '2026-09-02', periodTo: '2026-09-07', nights: 5, destination: 'Pune, India' });
    });

    test('a Month is one whole month, the one most of its receipts are in, and never widens', () => {
      const m = open({ kind: 'period' });
      put(m, '2026-08-31'); put(m, '2026-09-03'); put(m, '2026-09-20', { currency: 'INR' });
      expect(help.caseSuggestion(get(m), opts)).toMatchObject({ kind: 'period', title: 'September 2026 claims', periodFrom: '2026-09-01', periodTo: '2026-09-30' });
      const typed = open({ kind: 'period', periodFrom: '2026-09-01', periodTo: '2026-09-30' });
      put(typed, '2026-10-01');
      expect(help.caseSuggestion(get(typed), opts)).toMatchObject({ periodFrom: '2026-09-01', periodTo: '2026-09-30' });
    });

    test('the source line: how many receipts, where and when, from the receipts inside the dates', () => {
      const t = open({ kind: 'trip', periodFrom: '2026-09-01', periodTo: '2026-09-04' });
      put(t, '2026-08-31', { city: 'Singapore', country: 'SG' });
      india(t, '2026-09-01', 'Mumbai'); india(t, '2026-09-02', 'Pune'); india(t, '2026-09-04', 'Mumbai');
      put(t, '2026-10-20', { currency: 'THB', city: 'Bangkok' });
      expect(help.caseSuggestion(get(t), opts).basis).toEqual({ receipts: 4, cities: ['Mumbai', 'Pune'], countries: ['India', 'Singapore'], from: '2026-08-31', to: '2026-09-04' });
    });

    test('nothing read and dated: no suggestion', () => {
      const t = open({ kind: 'trip' });
      put(t, null); put(t, '2026-09-01', { status: 'reading' }); put(t, '2026-12-01');   // the future is a misread year
      expect(help.caseSuggestion(get(t), opts)).toBeNull();
      expect(help.caseSuggestion(null, opts)).toBeNull();
    });

    test('what is suggested is what handing the fields back gives', () => {
      const t = open({ kind: 'trip', periodFrom: '2026-09-01', periodTo: '2026-09-04', destination: 'Pune', nights: 3 });
      india(t, '2026-09-01', 'Mumbai'); india(t, '2026-09-06', 'Pune');
      const s = help.caseSuggestion(get(t), opts);
      reports.setCoverAi(t.id, { auto: ['periodFrom', 'periodTo', 'destination', 'nights'], user: [] });
      auto.refresh(t.id);
      const r = get(t);
      expect({ periodFrom: r.periodFrom, periodTo: r.periodTo, destination: r.destination, nights: r.nights })
        .toEqual({ periodFrom: s.periodFrom, periodTo: s.periodTo, destination: s.destination, nights: s.nights });
    });
  });

  describe('purposeDraft', () => {
    test('what the receipts were for, where and when', () => {
      const d = draft();
      india(d, '2026-09-01', 'Mumbai', 'hotel', 'Lodging');
      india(d, '2026-09-02', 'Pune', 'ride', 'Air & Transport');
      india(d, '2026-09-04', 'Mumbai', 'hotel', 'Lodging');
      india(d, '2026-09-03', 'Pune', 'parking', 'Air & Transport');
      expect(help.purposeDraft(get(d), opts)).toBe('Hotel stays and local transport in Mumbai and Pune, 1–4 Sep 2026');
    });

    test('never says why, and never names a merchant, a person or a note', () => {
      const d = draft();
      india(d, '2026-09-01', 'Mumbai', 'meal', 'Entertainment');
      store.updateExpense(get(d).expenses[0].id, { merchant: 'Acme Corp canteen', purpose: 'Dinner with Acme about the Chakan bid', description: 'Meeting with Mr Shah' });
      const p = help.purposeDraft(get(d), opts);
      expect(p).toBe('Entertainment in Mumbai, 1 Sep 2026');
      expect(p).not.toMatch(/Acme|Chakan|Shah|bid|meeting|dinner/i);
    });

    test('a flight is a flight, a train is transport, and a long list ends in other costs', () => {
      const d = draft();
      put(d, '2026-09-01', { currency: 'INR', docType: 'flight', lines: [{ category: 'Air & Transport', amount: 1 }] });
      put(d, '2026-09-02', { currency: 'INR', docType: 'other', lines: [{ category: 'Air & Transport', amount: 1 }] });
      put(d, '2026-09-02', { currency: 'INR', docType: 'ride', lines: [{ category: 'Air & Transport', amount: 1 }] });
      expect(help.purposeDraft(get(d), opts)).toBe('Flights and transport in India, 1–2 Sep 2026');
      put(d, '2026-09-03', { currency: 'INR', lines: [{ category: 'Meals', amount: 1 }, { category: 'Phone', amount: 1 }] });
      put(d, '2026-09-03', { currency: 'INR', docType: 'hotel', lines: [{ category: 'Lodging', amount: 1 }, { category: 'Medical/Dental', amount: 1 }] });
      expect(help.purposeDraft(get(d), opts)).toBe('Hotel stays, flights, transport and other costs in India, 1–3 Sep 2026');
    });

    test('at home, the town or the country; with no category, expenses', () => {
      const d = draft();
      put(d, '2026-10-03', { city: 'Singapore', country: 'SG', lines: [{ category: 'Meals', amount: 1 }] });
      put(d, '2026-10-09', { lines: [{ category: 'Meals', amount: 1 }] });
      expect(help.purposeDraft(get(d), opts)).toBe('Meals in Singapore, 3–9 Oct 2026');
      const bare = draft();
      put(bare, '2026-10-03', { currency: 'EUR' });
      expect(help.purposeDraft(get(bare), opts)).toBe('Expenses, 3 Oct 2026');
    });

    test('on a case with dates, only the receipts inside them; nothing read and dated is nothing to say', () => {
      const t = open({ kind: 'trip', periodFrom: '2026-09-01', periodTo: '2026-09-04' });
      india(t, '2026-09-01', 'Mumbai', 'hotel', 'Lodging');
      put(t, '2026-10-20', { currency: 'THB', city: 'Bangkok', lines: [{ category: 'Meals', amount: 1 }] });
      expect(help.purposeDraft(get(t), opts)).toBe('Hotel stays in Mumbai, 1 Sep 2026');
      const empty = open();
      put(empty, '2026-09-01', { status: 'reading' }); put(empty, null);
      expect(help.purposeDraft(get(empty), opts)).toBeNull();
    });
  });

  describe('pastPurposes', () => {
    test('the person\'s own three most recent, each once, never this case\'s or anybody else\'s', () => {
      const db = require('../db');
      const mk = (owner, purpose, at) => {
        const r = reports.createReport({ companyId: owner.companyId, userId: owner.id, title: 'x', purpose });
        db.prepare('UPDATE expense_reports SET created_at = ? WHERE id = ?').run(at, r.id);
        return r;
      };
      mk(u, 'Site visits at Chakan', '2026-06-01T00:00:00Z');
      mk(u, 'Client visits in Pune', '2026-07-01T00:00:00Z');
      mk(u, 'client visits in pune ', '2026-08-01T00:00:00Z');
      mk(u, 'Trade fair', '2026-08-15T00:00:00Z');
      mk(u, '  ', '2026-08-20T00:00:00Z');
      mk(other, 'Somebody else\'s client', '2026-09-01T00:00:00Z');
      const here = mk(u, 'This one', '2026-09-02T00:00:00Z');
      expect(help.pastPurposes(u.id, { exceptCase: here.id, except: 'This one' })).toEqual(['Trade fair', 'client visits in pune', 'Site visits at Chakan']);
      expect(help.pastPurposes(u.id, { except: 'trade FAIR' })).toEqual(['This one', 'client visits in pune', 'Site visits at Chakan']);
      expect(help.pastPurposes(null)).toEqual([]);
    });
  });
});
