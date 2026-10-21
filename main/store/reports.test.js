describe('store/reports', () => {
  let store, reports, users, u, m;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('./users'); store = require('./expenses'); reports = require('./reports');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123', name: 'Aisha' });
    m = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: u.companyId, name: 'Henry' });
  });
  const exp = (extra = {}) => store.createExpense({ companyId: u.companyId, userId: u.id, status: 'reviewed', currency: 'INR', total: 100, receiptDate: '2026-09-04',
    lines: [{ category: 'Lodging', amount: 60, baseAmount: 0.8, fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }, { category: 'Meals', amount: 40, baseAmount: 0.54, fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }], ...extra });

  test('numbers run per company and per year', () => {
    const year = require('../utils/zone-date').localDate('Asia/Singapore').slice(0, 4);
    const a = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'India trip' });
    const b = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Another' });
    expect(a.number).toBe(`EXP-${year}-0001`);
    expect(b.number).toBe(`EXP-${year}-0002`);
    expect(a.status).toBe('open');
  });

  // The server runs in UTC; Singapore's New Year arrives eight hours earlier.
  test("the number's year is the company's, not the server's", () => {
    jest.useFakeTimers({ now: new Date('2026-12-31T17:00:00Z'), doNotFake: ['setImmediate', 'nextTick'] });
    try {
      expect(reports.createReport({ companyId: u.companyId, userId: u.id, title: 'New Year' }).number).toMatch(/^EXP-2027-/);
    } finally { jest.useRealTimers(); }
  });

  // One with no amount was counted as waiting for a rate, which no rate fixes.
  test('a receipt with no amount is counted apart from one waiting for a rate', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'T' });
    reports.addExpense(r.id, exp({ lines: [] }).id);
    reports.addExpense(r.id, exp({ lines: [{ category: 'Meals', amount: 100 }] }).id);
    reports.addExpense(r.id, exp().id);
    expect(reports.getReport(r.id).totals).toMatchObject({ noAmount: 1, pendingRates: 1 });
    expect(reports.listReports({ userId: u.id }).rows[0]).toMatchObject({ noAmount: 1, pendingRates: 1 });
  });

  test('filing expenses gives totals by category, a reimbursement, and flags what is not ready', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'India trip', advances: 0.5 });
    const e1 = exp(); const e2 = exp({ status: 'review-needed' }); const e3 = exp({ lines: [{ category: 'Meals', amount: 100 }] });
    reports.addExpense(r.id, e1.id); reports.addExpense(r.id, e2.id); reports.addExpense(r.id, e3.id);
    const full = reports.getReport(r.id);
    expect(full.expenses).toHaveLength(3);
    expect(full.totals.byCategory).toEqual({ Lodging: 1.6, Meals: 1.08 });
    expect(full.totals.totalBase).toBe(2.68);
    expect(full.totals.reimbursement).toBe(2.18);
    expect(full.totals.pendingRates).toBe(1);
    expect(full.totals.unreviewed).toBe(1);
    reports.removeExpense(r.id, e3.id);
    expect(store.getExpense(e3.id).reportId).toBeNull();
    expect(reports.getReport(r.id).totals.pendingRates).toBe(0);
  });

  test('list carries summary totals and filters by user and status', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'A' });
    reports.addExpense(r.id, exp().id);
    reports.createReport({ companyId: u.companyId, userId: m.id, title: 'B' });
    const mine = reports.listReports({ userId: u.id }).rows;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'A', expenseCount: 1, totalBase: 1.34, ownerName: 'Aisha' });
    expect(reports.listReports({ companyId: u.companyId }).rows).toHaveLength(2);
    expect(reports.listReports({ companyId: u.companyId, status: 'claimed' }).rows).toHaveLength(0);
    expect(mine[0].unreviewed).toBe(0);
    expect(reports.listReports({ userIds: [] })).toMatchObject({ rows: [], total: 0 });
  });

  test('events are recorded with the actor', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'A' });
    reports.addEvent(r.id, u.id, 'claimed', null);
    reports.addEvent(r.id, m.id, 'reopened', 'marked by mistake');
    const ev = reports.listEvents(r.id);
    expect(ev.map(e => [e.action, e.actorName])).toEqual([['created', 'Aisha'], ['claimed', 'Aisha'], ['reopened', 'Henry']]);
  });

  test('deleting an open case unfiles its expenses', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'A' });
    const e = exp(); reports.addExpense(r.id, e.id);
    reports.deleteReport(r.id);
    expect(reports.getReport(r.id)).toBeNull();
    expect(store.getExpense(e.id).reportId).toBeNull();
  });

  test('the case list and the case page count receipts without a rate the same way', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'T' });
    const e = exp({ lines: [{ category: 'Lodging', amount: 60 }, { category: 'Meals', amount: 40 }] });   // two unpriced lines
    reports.addExpense(r.id, e.id);
    const listed = reports.listReports({ userId: u.id }).rows.find(x => x.id === r.id);
    expect(listed.pendingRates).toBe(1);
    expect(reports.getReport(r.id).totals.pendingRates).toBe(1);
  });

  test('head is the case row alone', () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'T' });
    expect(reports.head(r.id)).toMatchObject({ id: r.id, status: 'open', userId: u.id, companyId: u.companyId, xeroInvoiceId: null });
    expect(reports.head('nope')).toBeNull();
  });
});

describe('store/reports — drafts and the AI\'s cover', () => {
  let store, reports, users, db, u, year;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('./users'); store = require('./expenses'); reports = require('./reports'); db = require('../db');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123', name: 'Aisha' });
    year = require('../utils/zone-date').localDate('Asia/Singapore').slice(0, 4);
  });
  const draft = (extra = {}) => reports.createReport({ companyId: u.companyId, userId: u.id, draft: true, ...extra });
  const exp = (owner, extra = {}) => store.createExpense({ companyId: owner.companyId, userId: owner.id, status: 'reviewed', merchant: 'Grab', currency: 'SGD', total: 10, receiptDate: '2026-09-04',
    lines: [{ category: 'Other', amount: 10, baseAmount: 10, fxRate: 1, fxSource: 'base', fxRateDate: '2026-09-04' }], ...extra });

  test('a draft has no number, says it was made as a draft, and defaults to the kind that claims nothing', () => {
    const d = draft();
    expect(d).toMatchObject({ number: null, status: 'draft', kind: 'case', title: null, coverAi: { auto: [], user: [] } });
    expect(d.events.map(e => [e.action, e.note])).toEqual([['created', 'draft']]);
    expect(reports.createReport({ companyId: u.companyId, userId: u.id }).kind).toBe('case');
    expect(reports.createReport({ companyId: u.companyId, userId: u.id }).events[0].note).toBeNull();
  });

  test('cover fields given at creation are the owner\'s; empty ones are not', () => {
    const d = draft({ title: 'Pune', purpose: '', destination: null, kind: 'trip', nights: 0 });
    expect(d.coverAi).toEqual({ auto: [], user: ['kind', 'title', 'nights'] });
  });

  test('the number is taken when a draft is opened, so drafts leave no gaps', () => {
    const d1 = draft(), d2 = draft();
    const open = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Open' });
    expect(open.number).toBe(`EXP-${year}-0001`);
    reports.deleteReport(d1.id);                                        // abandoned
    const opened = reports.openDraft(d2.id, {}, u.id);
    expect(opened).toMatchObject({ number: `EXP-${year}-0002`, status: 'open' });
    expect(opened.events.map(e => e.action)).toEqual(['created', 'opened']);
    expect(reports.openDraft(d2.id, {}, u.id)).toBeNull();               // once
    expect(reports.openDraft(open.id, {}, u.id)).toBeNull();             // not a draft
    expect(reports.openDraft('nope', {}, u.id)).toBeNull();
  });

  test('opening saves what was sent as the owner\'s, and names a draft that has no title', () => {
    const d = draft();
    reports.addExpense(d.id, exp(u, { currency: 'INR' }).id);
    reports.setCoverAi(d.id, { auto: ['destination'], user: [] });
    const opened = reports.openDraft(d.id, { purpose: 'Client visits', destination: 'Pune' }, u.id);
    expect(opened).toMatchObject({ purpose: 'Client visits', destination: 'Pune', title: 'India trip, Sep 2026' });
    expect(opened.coverAi).toEqual({ auto: ['title'], user: ['purpose', 'destination'] });

    // nothing read yet: named by the day it was opened
    const bare = reports.openDraft(draft().id, {}, u.id);
    const today = require('../utils/zone-date').localDate('Asia/Singapore');
    expect(bare.title).toBe(`Receipts, ${require('../reports/cover-suggest').dayRange(today, today)}`);
    expect(bare.title).toMatch(/^Receipts, \d{1,2} [A-Z][a-z]{2} \d{4}$/);
    // a title given is kept
    expect(reports.openDraft(draft().id, { title: 'Chakan job' }, u.id)).toMatchObject({ title: 'Chakan job', coverAi: { auto: [], user: ['title'] } });
  });

  test('editing the cover makes those fields the owner\'s and takes them off the AI\'s', () => {
    const d = draft();
    reports.setCoverAi(d.id, { auto: ['title', 'destination', 'bogus'], user: [] });
    expect(reports.getReport(d.id).coverAi).toEqual({ auto: ['title', 'destination'], user: [] });
    const after = reports.updateReport(d.id, { title: 'Mine', advances: 5 });
    expect(after.coverAi).toEqual({ auto: ['destination'], user: ['title'] });
    expect(reports.updateReport(d.id, { notes: 'x' }).coverAi).toEqual({ auto: ['destination'], user: ['title'] });
    // a cleared field is the owner's too: the AI does not put it back
    expect(reports.updateReport(d.id, { destination: '' }).coverAi).toEqual({ auto: [], user: ['title', 'destination'] });
  });

  test('a cover record that cannot be read is an empty one', () => {
    const d = draft();
    for (const raw of ['not json', '{"auto":"title"}', 'null', '[]', '{"auto":["title",3],"user":null}']) {
      db.prepare('UPDATE expense_reports SET cover_ai = ? WHERE id = ?').run(raw, d.id);
      const ai = reports.getReport(d.id).coverAi;
      expect(ai.user).toEqual([]);
      expect(ai.auto.every(f => reports.AI_FIELDS.includes(f))).toBe(true);
    }
    db.prepare('UPDATE expense_reports SET cover_ai = NULL WHERE id = ?').run(d.id);
    expect(reports.getReport(d.id).coverAi).toEqual({ auto: [], user: [] });
  });

  test('merging moves every receipt, says so on the target, and removes the source', () => {
    const src = draft(), dst = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Pune' });
    const a = exp(u), b = exp(u);
    reports.addExpense(src.id, a.id); reports.addExpense(src.id, b.id);
    expect(reports.mergeInto(src.id, dst.id, u.id)).toBe(2);
    expect(reports.getReport(src.id)).toBeNull();
    const t = reports.getReport(dst.id);
    expect(t.expenses.map(e => e.id).sort()).toEqual([a.id, b.id].sort());
    expect(t.events.at(-1)).toMatchObject({ action: 'edited', note: 'Merged 2 receipts from a draft', actorId: u.id });
    const named = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Old' });
    reports.addExpense(named.id, exp(u).id);
    reports.mergeInto(named.id, dst.id, u.id);
    expect(reports.getReport(dst.id).events.at(-1).note).toBe(`Merged 1 receipt from ${named.number} (Old)`);
    expect(reports.mergeInto(dst.id, dst.id, u.id)).toBe(0);
    expect(reports.getReport(dst.id).expenses).toHaveLength(3);
  });
});

describe('store/reports — the cases list', () => {
  let store, reports, users, db, u, m;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('./users'); store = require('./expenses'); reports = require('./reports'); db = require('../db');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123', name: 'Aisha' });
    m = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: u.companyId, name: 'Henry' });
  });
  const kase = (owner, extra = {}) => reports.createReport({ companyId: owner.companyId, userId: owner.id, ...extra });
  const put = (c, extra = {}) => {
    const total = extra.total ?? 10;
    const e = store.createExpense({ companyId: c.companyId, userId: c.userId, status: 'reviewed', merchant: 'Grab', currency: 'SGD', total, receiptDate: '2026-09-04',
      lines: [{ category: 'Other', amount: total, baseAmount: total, fxRate: 1, fxSource: 'base', fxRateDate: '2026-09-04' }], ...extra });
    reports.addExpense(c.id, e.id);
    return e;
  };
  const at = (c, iso) => db.prepare('UPDATE expense_reports SET created_at = ? WHERE id = ?').run(iso, c.id);
  const titles = out => out.rows.map(r => r.title);

  test('every row says whether it is ready and how many receipts are still being read', () => {
    put(kase(u, { title: 'Ready' }));
    put(kase(u, { title: 'Unchecked' }), { status: 'review-needed' });
    put(kase(u, { title: 'Reading' }), { status: 'reading', lines: [] });
    put(kase(u, { title: 'Unpriced' }), { lines: [{ category: 'Other', amount: 10 }] });
    kase(u, { title: 'Empty' });
    put(kase(u, { title: 'Draft', draft: true }));
    const rows = Object.fromEntries(reports.listReports({ userId: u.id }).rows.map(r => [r.title, r]));
    expect(rows.Ready).toMatchObject({ ready: true, reading: 0, coverAi: { auto: [], user: ['title'] } });
    expect(rows.Unchecked.ready).toBe(false);
    expect(rows.Reading).toMatchObject({ ready: false, reading: 1 });
    expect(rows.Unpriced.ready).toBe(false);
    expect(rows.Empty.ready).toBe(false);
    expect(rows.Draft.ready).toBe(false);                               // only an open case is ready
    expect(rows.Ready).not.toHaveProperty('_hit');
  });

  test('status, kind, ready and posted narrow the rows; the counts stay those of the scope', () => {
    put(kase(u, { title: 'A', kind: 'trip' }));
    kase(u, { title: 'B', kind: 'period' });
    kase(u, { title: 'C', draft: true });
    const claimed = kase(u, { title: 'D', kind: 'trip' }); put(claimed);
    db.prepare("UPDATE expense_reports SET status = 'claimed', xero_invoice_id = 'INV-1' WHERE id = ?").run(claimed.id);
    kase(m, { title: 'Theirs' });
    const counts = { draft: 1, open: 2, ready: 1, claimed: 1, all: 4 };
    expect(reports.listReports({ userId: u.id })).toMatchObject({ total: 4, counts });
    expect(titles(reports.listReports({ userId: u.id, status: 'draft,open' })).sort()).toEqual(['A', 'B', 'C']);
    expect(titles(reports.listReports({ userId: u.id, status: ['claimed'] }))).toEqual(['D']);
    expect(reports.listReports({ userId: u.id, status: 'claimed' }).counts).toEqual(counts);
    expect(titles(reports.listReports({ userId: u.id, kind: 'trip' })).sort()).toEqual(['A', 'D']);
    expect(titles(reports.listReports({ userId: u.id, ready: '1' }))).toEqual(['A']);
    expect(titles(reports.listReports({ userId: u.id, posted: '1' }))).toEqual(['D']);
    expect(titles(reports.listReports({ userId: u.id, posted: '0' })).sort()).toEqual(['A', 'B', 'C']);
    // an admin's company-wide scope, and one owner within it
    expect(reports.listReports({ companyId: u.companyId }).counts.all).toBe(5);
    expect(reports.listReports({ companyId: u.companyId, owner: m.id })).toMatchObject({ total: 1, counts: { all: 1, open: 1 } });
  });

  test('the search looks at the cover and at every merchant in the case, and takes what was typed literally', () => {
    const a = kase(u, { title: 'India trip', purpose: 'Client visits', destination: 'Pune' }); put(a, { merchant: 'Courtyard by Marriott' });
    put(kase(u, { title: '100% fuel', purpose: 'Mileage' }), { merchant: 'Shell' });
    kase(u, { title: 'Under_score' });
    expect(titles(reports.listReports({ userId: u.id, q: 'india' }))).toEqual(['India trip']);
    expect(titles(reports.listReports({ userId: u.id, q: 'marriott' }))).toEqual(['India trip']);
    expect(titles(reports.listReports({ userId: u.id, q: ' pune ' }))).toEqual(['India trip']);
    expect(titles(reports.listReports({ userId: u.id, q: 'mileage' }))).toEqual(['100% fuel']);
    expect(titles(reports.listReports({ userId: u.id, q: a.number }))).toEqual(['India trip']);
    expect(titles(reports.listReports({ userId: u.id, q: '0%' }))).toEqual(['100% fuel']);
    expect(titles(reports.listReports({ userId: u.id, q: '%' }))).toEqual(['100% fuel']);
    expect(titles(reports.listReports({ userId: u.id, q: 'r_s' }))).toEqual(['Under_score']);
    expect(reports.listReports({ userId: u.id, q: 'zzz' })).toMatchObject({ rows: [], total: 0, counts: { all: 3 } });
  });

  test('sorted newest, oldest, by amount or by dates, and paged', () => {
    const a = kase(u, { title: 'A', periodFrom: '2026-08-01' }); put(a, { total: 5 }); at(a, '2026-09-01T00:00:00Z');
    const b = kase(u, { title: 'B' }); put(b, { total: 50 }); at(b, '2026-09-03T00:00:00Z');
    const c = kase(u, { title: 'C', periodFrom: '2026-09-15' }); put(c, { total: 20 }); at(c, '2026-09-02T00:00:00Z');
    expect(titles(reports.listReports({ userId: u.id }))).toEqual(['B', 'C', 'A']);
    expect(titles(reports.listReports({ userId: u.id, sort: 'oldest' }))).toEqual(['A', 'C', 'B']);
    expect(titles(reports.listReports({ userId: u.id, sort: 'amount' }))).toEqual(['B', 'C', 'A']);
    expect(titles(reports.listReports({ userId: u.id, sort: 'dates' }))).toEqual(['C', 'A', 'B']);
    expect(reports.listReports({ userId: u.id, limit: 2 })).toMatchObject({ total: 3 });
    expect(titles(reports.listReports({ userId: u.id, limit: 2 }))).toEqual(['B', 'C']);
    expect(titles(reports.listReports({ userId: u.id, limit: 2, offset: 2 }))).toEqual(['A']);
    expect(titles(reports.listReports({ userId: u.id, limit: 2, offset: 9 }))).toEqual([]);
    expect(titles(reports.listReports({ userId: u.id, offset: 1 }))).toEqual(['C', 'A']);
  });
});
