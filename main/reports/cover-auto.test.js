describe('reports/cover-auto', () => {
  let store, reports, users, auto, db, u;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports'); auto = require('./cover-auto'); db = require('../db');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
  });
  const draft = (extra = {}) => reports.createReport({ companyId: u.companyId, userId: u.id, draft: true, ...extra });
  const put = (c, receiptDate, extra = {}) => reports.addExpense(c.id, store.createExpense({ companyId: u.companyId, userId: u.id, status: 'review-needed', receiptDate, currency: 'SGD', ...extra }).id);
  const cover = id => { const r = reports.getReport(id); return { kind: r.kind, title: r.title, periodFrom: r.periodFrom, periodTo: r.periodTo, destination: r.destination, nights: r.nights, purpose: r.purpose, coverAi: r.coverAi }; };

  test('a draft gets every field the owner has not set, marked as the AI\'s, with no event', () => {
    const d = draft();
    put(d, '2026-09-01', { currency: 'INR' }); put(d, '2026-09-04', { currency: 'INR' });
    expect(auto.refresh(d.id)).toEqual({ changed: ['kind', 'title', 'periodFrom', 'periodTo', 'destination', 'nights'] });
    expect(cover(d.id)).toEqual({ kind: 'trip', title: 'India trip, Sep 2026', periodFrom: '2026-09-01', periodTo: '2026-09-04', destination: 'India', nights: 3, purpose: null,
                                  coverAi: { auto: ['kind', 'title', 'periodFrom', 'periodTo', 'destination', 'nights'], user: [] } });
    expect(reports.getReport(d.id).events.map(e => e.action)).toEqual(['created']);
    expect(auto.refresh(d.id)).toBeNull();                               // nothing new to say
  });

  test('what the owner set stays theirs, before the AI wrote it or after', () => {
    const d = draft({ title: 'Pune visit' });
    put(d, '2026-09-01', { currency: 'INR' });
    auto.refresh(d.id);
    expect(cover(d.id)).toMatchObject({ title: 'Pune visit', kind: 'trip', coverAi: { user: ['title'] } });
    reports.updateReport(d.id, { destination: 'Pune', kind: 'case' });
    put(d, '2026-09-05', { currency: 'INR' });
    auto.refresh(d.id);
    expect(cover(d.id)).toMatchObject({ title: 'Pune visit', kind: 'case', destination: 'Pune', periodTo: '2026-09-05', nights: 4 });
    expect(cover(d.id).coverAi.auto.sort()).toEqual(['nights', 'periodFrom', 'periodTo']);
  });

  test('a draft that stops being a trip loses the destination and nights the AI gave it', () => {
    const d = draft();
    const e = store.createExpense({ companyId: u.companyId, userId: u.id, status: 'review-needed', receiptDate: '2026-09-04', currency: 'INR' });
    reports.addExpense(d.id, e.id); put(d, '2026-09-10');
    auto.refresh(d.id);
    expect(cover(d.id)).toMatchObject({ kind: 'trip', destination: 'India', nights: 6 });
    store.updateExpense(e.id, { currency: 'SGD' });                     // it was a Singapore receipt after all
    auto.refresh(d.id);
    expect(cover(d.id)).toMatchObject({ kind: 'period', title: 'September 2026 claims', periodFrom: '2026-09-01', periodTo: '2026-09-30', destination: null, nights: null });
    expect(cover(d.id).coverAi.auto.sort()).toEqual(['kind', 'periodFrom', 'periodTo', 'title']);
  });

  test('an open case gets only its dates, destination and nights, and only where nobody put something', () => {
    const c = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Chakan job', kind: 'case' });
    put(c, '2026-09-01', { currency: 'INR' }); put(c, '2026-09-03', { currency: 'INR' });
    expect(auto.refresh(c.id)).toEqual({ changed: ['periodFrom', 'periodTo', 'destination', 'nights'] });
    expect(cover(c.id)).toMatchObject({ kind: 'case', title: 'Chakan job', periodFrom: '2026-09-01', periodTo: '2026-09-03', destination: 'India', nights: 2 });
    put(c, '2026-09-06', { currency: 'INR' });
    auto.refresh(c.id);
    expect(cover(c.id)).toMatchObject({ periodTo: '2026-09-06', nights: 5 });

    // a case from before the AI kept track: its dates were typed by somebody
    const old = reports.createReport({ companyId: u.companyId, userId: u.id });
    db.prepare("UPDATE expense_reports SET period_from = '2026-08-30', cover_ai = NULL WHERE id = ?").run(old.id);
    put(old, '2026-09-01', { currency: 'INR' });
    auto.refresh(old.id);
    expect(cover(old.id)).toMatchObject({ periodFrom: '2026-08-30', periodTo: '2026-09-01', destination: 'India', kind: 'case', title: null });
  });

  // The QA pass: a reopened India trip took a Singapore receipt from seven
  // weeks later, its dates stretched to fit, and every October draft was then
  // offered the trip as its home.
  test('an open trip takes in a receipt beside its dates, not one weeks away; a month never widens', () => {
    const d = draft();
    put(d, '2026-09-01', { currency: 'INR', country: 'IN', city: 'Mumbai', docType: 'hotel' });
    put(d, '2026-09-04', { currency: 'INR', country: 'IN', city: 'Pune', docType: 'hotel' });
    auto.refresh(d.id);
    reports.openDraft(d.id, {}, u.id);
    expect(cover(d.id)).toMatchObject({ kind: 'trip', periodFrom: '2026-09-01', periodTo: '2026-09-04', nights: 3 });

    put(d, '2026-10-21', { currency: 'SGD', country: 'SG', city: 'Singapore', docType: 'meal' });
    auto.refresh(d.id);
    expect(cover(d.id)).toMatchObject({ periodFrom: '2026-09-01', periodTo: '2026-09-04', nights: 3, destination: 'Mumbai, Pune, India' });
    const late = reports.getReport(d.id).expenses.find(e => e.receiptDate === '2026-10-21');
    const { flagsFor } = require('../receipts/flags');
    expect(flagsFor(late, reports.getReport(d.id), { baseCurrency: 'SGD', today: '2026-10-22' }).map(f => f.code)).toContain('outside-case');

    put(d, '2026-09-06', { currency: 'INR', country: 'IN', city: 'Mumbai', docType: 'ride' });     // the taxi two days after
    auto.refresh(d.id);
    expect(cover(d.id)).toMatchObject({ periodFrom: '2026-09-01', periodTo: '2026-09-06', nights: 5 });

    const m = draft();
    put(m, '2026-09-02'); put(m, '2026-09-20');
    auto.refresh(m.id);
    reports.openDraft(m.id, {}, u.id);
    expect(cover(m.id)).toMatchObject({ kind: 'period', periodFrom: '2026-09-01', periodTo: '2026-09-30' });
    put(m, '2026-10-01');                                                 // the next day, but the next month
    auto.refresh(m.id);
    expect(cover(m.id)).toMatchObject({ periodFrom: '2026-09-01', periodTo: '2026-09-30' });
  });

  // The phase 6 QA pass: mileage on an undated trip dated it 1-31 Oct and
  // offered a 31-day per diem; a receipt the day after typed dates made the
  // nights one more than the dates said.
  test('mileage and per diem date nothing, and the nights follow the dates the case has', () => {
    const t = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Undated', kind: 'trip' });
    put(t, '2026-10-01', { source: 'mileage', status: 'reviewed', merchant: 'Mileage' });
    auto.refresh(t.id);
    expect(cover(t.id)).toMatchObject({ periodFrom: null, periodTo: null, nights: null });
    put(t, '2026-10-03', { currency: 'INR' });                         // a real receipt does date it, to itself
    auto.refresh(t.id);
    expect(cover(t.id)).toMatchObject({ periodFrom: '2026-10-03', periodTo: '2026-10-03', nights: 0 });

    const typed = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Pune', kind: 'trip', periodFrom: '2026-09-01', periodTo: '2026-09-04' });
    put(typed, '2026-09-02', { currency: 'INR' }); put(typed, '2026-09-05', { currency: 'INR' });
    auto.refresh(typed.id);
    expect(cover(typed.id)).toMatchObject({ periodFrom: '2026-09-01', periodTo: '2026-09-04', nights: 3 });
  });

  test('a claimed case is left as it was claimed', () => {
    const c = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'T' });
    put(c, '2026-09-01', { currency: 'INR' });
    db.prepare("UPDATE expense_reports SET status = 'claimed' WHERE id = ?").run(c.id);
    expect(auto.refresh(c.id)).toBeNull();
    expect(cover(c.id)).toMatchObject({ periodFrom: null, destination: null });
  });

  test('nothing read and dated, or no such case: nothing written', () => {
    const d = draft();
    put(d, null); put(d, '2026-09-01', { status: 'reading' });
    expect(auto.refresh(d.id)).toBeNull();
    expect(cover(d.id)).toMatchObject({ title: null, kind: 'case', coverAi: { auto: [], user: [] } });
    expect(auto.refresh('nope')).toBeNull();
    expect(auto.refresh(null)).toBeNull();
  });

  test('a failure is logged and never thrown at the caller', () => {
    const d = draft(); put(d, '2026-09-01');
    const warn = jest.spyOn(require('../utils/logger'), 'warn').mockImplementation(() => {});
    jest.spyOn(reports, 'applyAutoCover').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => auto.refresh(d.id)).not.toThrow();
    expect(auto.refresh(d.id)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cover/), expect.objectContaining({ reportId: d.id, error: 'disk full' }));
  });
});
