const request = require('supertest');
const express = require('express');
const { serverFor } = require('../scripts/test-server');

describe('dashboard summary', () => {
  let users, store, reports, wf, summary, app, cid, boss, ela, mar;

  const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  // A priced expense, without going near a rate provider: the lines carry
  // baseAmount directly, which is what applyFx would have written.
  const spend = (who, { merchant, amount, base, ccy = 'SGD', cat = 'Meals', date, status = 'reviewed' }) =>
    store.createExpense({
      companyId: cid, userId: who.id, source: 'upload', status, merchant, receiptDate: date,
      currency: ccy, total: amount, category: cat,
      lines: [{ category: cat, description: merchant, amount, currency: ccy, baseAmount: base }],
    });

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('./users'); store = require('./expenses'); reports = require('./reports');
    wf = require('../reports/workflow'); summary = require('./summary').summary;

    boss = await users.createUser({ email: 'wk@solv.sg', password: 'password123', name: 'Wei Kang' });
    cid = boss.companyId;
    ela = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: cid, name: 'Elaine' });
    mar = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: cid, name: 'Marcus' });

    app = express();
    app.use(express.json());
    app.use('/api/dashboard', require('../routes/dashboard'));
  });

  const me = u => users.findById(u.id);

  test('an employee is totalled over their own expenses only', () => {
    spend(ela, { merchant: 'Hotel', amount: 1289, base: 403.84, ccy: 'MYR', cat: 'Lodging', date: day(3) });
    spend(mar, { merchant: 'Someone else', amount: 500, base: 500, date: day(3) });
    const s = summary(me(ela));
    expect(s.scope).toBe('own');
    expect(s.total).toBe(403.84);
    expect(s.byCategory).toEqual([{ category: 'Lodging', base: 403.84, lines: 1, share: 1 }]);
  });

  test('an admin is totalled over the company', () => {
    spend(ela, { merchant: 'Hotel', amount: 100, base: 100, date: day(2) });
    spend(mar, { merchant: 'Taxi', amount: 999, base: 999, date: day(2) });
    expect(summary(me(boss)).scope).toBe('company');
    expect(summary(me(boss)).total).toBe(1099);
    expect(summary(me(mar)).total).toBe(999);
  });

  // The scope comes from the caller's own row. There is no parameter for it,
  // and this pins that an employee cannot ask for anybody else's figures.
  test('the route scopes by who is asking, not by what they ask for', async () => {
    spend(mar, { merchant: 'Not yours', amount: 999, base: 999, date: day(2) });
    const jwt = require('jsonwebtoken');
    const secret = require('../middleware/auth-middleware').jwtSecret();
    const as = u => ({ Authorization: `Bearer ${jwt.sign({ id: u.id, email: u.email, role: users.findById(u.id).role }, secret)}` });

    const mine = await request(serverFor(app)).get('/api/dashboard/summary').set(as(ela)).expect(200);
    expect(mine.body.scope).toBe('own');
    expect(mine.body.total).toBe(0);

    const asked = await request(serverFor(app)).get('/api/dashboard/summary?scope=company&userId=' + mar.id).set(as(ela)).expect(200);
    expect(asked.body.scope).toBe('own');
    expect(asked.body.total).toBe(0);
  });

  test('every month in the window is a column, including the empty ones', () => {
    spend(ela, { merchant: 'Lunch', amount: 20, base: 20, date: day(1) });
    const s = summary(me(ela));
    expect(s.months).toHaveLength(6);
    expect(s.months.map(m => m.month)).toEqual([...s.months].map(m => m.month).sort());   // oldest first
    expect(s.months[s.months.length - 1].base).toBe(20);
    expect(s.months.filter(m => m.base === 0).length).toBeGreaterThan(0);
    expect(s.thisMonth).toBe(20);
  });

  test('a duplicate or rejected receipt is not money anybody spent', () => {
    spend(ela, { merchant: 'Real', amount: 100, base: 100, date: day(1) });
    spend(ela, { merchant: 'Same again', amount: 100, base: 100, date: day(1), status: 'duplicate' });
    spend(ela, { merchant: 'Refused', amount: 100, base: 100, date: day(1), status: 'rejected' });
    expect(summary(me(ela)).total).toBe(100);
  });

  // A line with no rate has no base amount. Counting it as zero would make the
  // chart quietly wrong; it is reported instead.
  test('lines with no exchange rate are counted, not silently dropped', () => {
    spend(ela, { merchant: 'Priced', amount: 100, base: 100, date: day(1) });
    store.createExpense({
      companyId: cid, userId: ela.id, status: 'reviewed', merchant: 'No rate yet', receiptDate: day(1),
      currency: 'VND', total: 12400000,
      lines: [{ category: 'Lodging', description: '3 nights', amount: 12400000, currency: 'VND' }],
    });
    const s = summary(me(ela));
    expect(s.total).toBe(100);
    expect(s.unpricedLines).toBe(1);
  });

  test('currencies are shared out by what they came to in the base currency', () => {
    spend(ela, { merchant: 'KL hotel', amount: 1000, base: 300, ccy: 'MYR', cat: 'Lodging', date: day(1) });
    spend(ela, { merchant: 'Lunch', amount: 100, base: 100, ccy: 'SGD', date: day(1) });
    const s = summary(me(ela));
    expect(s.byCurrency).toEqual([
      { currency: 'MYR', base: 300, receipts: 1, share: 0.75 },
      { currency: 'SGD', base: 100, receipts: 1, share: 0.25 },
    ]);
  });

  test('how long a case stays open, and null rather than zero when none has been claimed', () => {
    const fresh = summary(me(ela));
    expect(fresh.cycle.openToClaimed).toBeNull();
    expect(fresh.cycle.claimedCount).toBe(0);

    const r = reports.createReport({ companyId: cid, userId: ela.id, title: 'Trip' });
    reports.addExpense(r.id, spend(ela, { merchant: 'Hotel', amount: 100, base: 100, date: day(1) }).id);
    // opened four days ago, claimed now
    require('../db').prepare('UPDATE expense_reports SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 4 * 86400000).toISOString(), r.id);
    expect(summary(me(ela)).cycle.openCount).toBe(1);
    wf.markClaimed(r.id, ela);

    const s = summary(me(ela));
    expect(s.cycle.openToClaimed).toBe(4);
    expect(s.cycle.claimedCount).toBe(1);
    expect(s.cycle.openCount).toBe(0);
    expect(s.claimed).toBe(100);
  });

  // Receipt dates are plain dates, written where the claimant is. Asked in UTC,
  // the window called September "this month" for the first eight hours of every
  // October in Singapore, and a receipt dated the 1st fell outside it entirely.
  test('the month window is the company\'s month, not UTC\'s', () => {
    const { _monthKeys } = require('./summary');
    const justAfterMidnightInSingapore = new Date('2026-09-30T16:30:00Z');
    expect(_monthKeys(justAfterMidnightInSingapore, 'UTC').slice(-1)[0]).toBe('2026-09');
    expect(_monthKeys(justAfterMidnightInSingapore, 'Asia/Singapore').slice(-1)[0]).toBe('2026-10');
    expect(_monthKeys(justAfterMidnightInSingapore, 'Asia/Singapore')).toHaveLength(6);
    expect(_monthKeys(justAfterMidnightInSingapore, 'Asia/Singapore')[0]).toBe('2026-05');
    // A zone nobody recognises is a misconfiguration, not a reason to answer nothing.
    expect(_monthKeys(justAfterMidnightInSingapore, 'Not/AZone').slice(-1)[0]).toBe('2026-09');
  });

  test('a receipt claimed on its own counts as claimed', () => {
    const e = spend(ela, { merchant: 'A one-off', amount: 250, base: 250, date: day(1) });
    expect(summary(me(ela)).claimed).toBe(0);
    wf.markExpenseClaimed(e.id, me(ela));
    const s = summary(me(ela));
    expect(s.claimed).toBe(250);
    expect(s.total).toBe(250);            // still counted as spend, claimed or not
    wf.markExpenseClaimed(e.id, me(ela), false);
    expect(summary(me(ela)).claimed).toBe(0);
  });

  // Money in an open case is open; once its receipt is claimed it is not
  // still open as well, so it must not sit in both figures at once.
  test('what is open, and what is already claimed, are not counted twice', () => {
    const r = reports.createReport({ companyId: cid, userId: ela.id, title: 'Trip' });
    const e = spend(ela, { merchant: 'Hotel', amount: 300, base: 300, date: day(1) });
    reports.addExpense(r.id, e.id);
    const loose = spend(ela, { merchant: 'Taxi', amount: 20, base: 20, date: day(1) });   // in no case: open too
    expect(summary(me(ela)).open).toBe(320);
    wf.markExpenseClaimed(e.id, me(ela));
    const s = summary(me(ela));
    expect(s.open).toBe(20);
    expect(s.claimed).toBe(300);
    wf.markExpenseClaimed(loose.id, me(ela));
    expect(summary(me(ela)).open).toBe(0);
  });

  test('an expense is dated by its receipt, not by when it was filed', () => {
    const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15)).toISOString().slice(0, 10);
    spend(ela, { merchant: 'Late claim', amount: 80, base: 80, date: lastMonth });
    const s = summary(me(ela));
    expect(s.thisMonth).toBe(0);
    expect(s.lastMonth).toBe(80);
  });
});
