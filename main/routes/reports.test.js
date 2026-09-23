const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.01341, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: '2026-09-18T03:00:00.000Z' }) }));

describe('routes/reports', () => {
  let app, users, store, admin, emp, other, tokens;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'Admin' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, name: 'Elaine Khoo', department: 'Sales', employeeId: 'S0042' });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/reports', require('./reports')); app.use('/api/expenses', require('./expenses'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const reviewed = (owner, extra = {}) => store.createExpense({ companyId: owner.companyId, userId: owner.id, status: 'reviewed', currency: 'INR', total: 100, receiptDate: '2026-09-04', merchant: 'Courtyard',
    lines: [{ category: 'Lodging', amount: 100, baseAmount: 1.34, fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }], ...extra });
  const create = (u, body = { title: 'India trip', purpose: 'Client visits', periodFrom: '2026-08-31', periodTo: '2026-09-04', destination: 'Pune' }) => request(serverFor(app)).post('/api/reports').set(as(u)).send(body);

  test('create, file expenses, read back with totals; only unfiled own reviewed expenses can be filed', async () => {
    const r = (await create(emp).expect(201)).body.report;
    expect(r.number).toMatch(/^EXP-\d{4}-0001$/);
    const e1 = reviewed(emp), e2 = reviewed(other), e3 = reviewed(emp, { status: 'review-needed' });
    const filed = await request(serverFor(app)).post(`/api/reports/${r.id}/expenses`).set(as(emp)).send({ expenseIds: [e1.id, e2.id, e3.id] }).expect(200);
    expect(filed.body.report.expenses.map(e => e.id)).toEqual([e1.id]);
    expect(filed.body.skipped).toHaveLength(2);
    expect(filed.body.report.totals.totalBase).toBe(1.34);
    await request(serverFor(app)).delete(`/api/reports/${r.id}/expenses/${e1.id}`).set(as(emp)).expect(200);
    await request(serverFor(app)).delete(`/api/reports/${r.id}/expenses/${e1.id}`).set(as(emp)).expect(404);
    await request(serverFor(app)).get(`/api/reports/${r.id}`).set(as(other)).expect(404);
    const view = await request(serverFor(app)).get(`/api/reports/${r.id}`).set(as(admin)).expect(200);
    expect(view.body).toMatchObject({ editable: true, isOwner: false });
    expect(view.body.report.status).toBe('open');
  });

  test('the whole journey: open, claimed by the owner, locked, reopened; wrong actors are refused', async () => {
    const r = (await create(emp)).body.report; const e = reviewed(emp);
    await request(serverFor(app)).post(`/api/reports/${r.id}/expenses`).set(as(emp)).send({ expenseIds: [e.id] });
    await request(serverFor(app)).post(`/api/reports/${r.id}/claimed`).set(as(other)).expect(404);       // not theirs to see
    const p = await request(serverFor(app)).post(`/api/reports/${r.id}/claimed`).set(as(emp)).expect(200);
    expect(p.body.report.status).toBe('claimed');
    expect(p.body.report.claimedAt).toBeTruthy();
    expect(p.body.report.events.map(x => x.action)).toEqual(['created', 'claimed']);
    // claiming the case claimed what was in it, and locked it
    const claimed = await request(serverFor(app)).get(`/api/expenses/${e.id}`).set(as(emp)).expect(200);
    expect(claimed.body.expense.claimed).toBe(true);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ purpose: 'x' }).expect(409);
    await request(serverFor(app)).patch(`/api/reports/${r.id}`).set(as(emp)).send({ title: 'x' }).expect(409);
    await request(serverFor(app)).post(`/api/reports/${r.id}/claimed`).set(as(emp)).expect(400);         // already
    // reopening is the owner's or an admin's, and frees the receipts again
    await request(serverFor(app)).post(`/api/reports/${r.id}/reopen`).set(as(other)).expect(404);
    const ro = await request(serverFor(app)).post(`/api/reports/${r.id}/reopen`).set(as(admin)).expect(200);
    expect(ro.body.report.status).toBe('open');
    expect(ro.body.report.events.map(x => x.action)).toEqual(['created', 'claimed', 'reopened']);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ purpose: 'Client visit' }).expect(200);
  });

  test('a case with an unchecked receipt cannot be claimed, and says so', async () => {
    const r = (await create(emp)).body.report;
    const e = reviewed(emp, { status: 'review-needed' });
    // the filing route refuses an unchecked one, so it goes in through the store
    require('../store/reports').addExpense(r.id, e.id);
    const res = await request(serverFor(app)).post(`/api/reports/${r.id}/claimed`).set(as(emp)).expect(400);
    expect(res.body.error).toMatch(/not checked/);
  });

  test('listing: own for a user, everyone for an admin, and only an admin; open cases can be deleted', async () => {
    const mine = (await create(emp)).body.report; await create(other);
    expect((await request(serverFor(app)).get('/api/reports').set(as(emp)).expect(200)).body.reports.map(r => r.id)).toEqual([mine.id]);
    expect((await request(serverFor(app)).get('/api/reports?scope=all').set(as(emp)).expect(200)).body.reports.map(r => r.id)).toEqual([mine.id]);   // asking does not widen it
    expect((await request(serverFor(app)).get('/api/reports?scope=all').set(as(admin)).expect(200)).body.reports).toHaveLength(2);
    await request(serverFor(app)).delete(`/api/reports/${mine.id}`).set(as(other)).expect(404);
    await request(serverFor(app)).delete(`/api/reports/${mine.id}`).set(as(emp)).expect(200);
  });

  test('exports: a signed link, then a real PDF, an XLSX and a CSV', async () => {
    const r = (await create(emp)).body.report; const e = reviewed(emp);
    await request(serverFor(app)).post(`/api/reports/${r.id}/expenses`).set(as(emp)).send({ expenseIds: [e.id] });
    const binary = (res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
    for (const [format, type, magic] of [['pdf', /application\/pdf/, '%PDF'], ['xlsx', /spreadsheetml/, 'PK'], ['csv', /text\/csv/, 'Report,Line']]) {
      const u = await request(serverFor(app)).get(`/api/reports/${r.id}/export-url?format=${format}`).set(as(emp)).expect(200);
      const res = await request(serverFor(app)).get(u.body.url).buffer(true).parse(binary).expect(200).expect('Content-Type', type);
      expect(Buffer.from(res.body).toString('latin1').startsWith(magic)).toBe(true);
      expect(res.headers['content-disposition']).toContain('EXP-');
    }
    await request(serverFor(app)).get(`/api/reports/${r.id}/export?token=bad`).expect(401);
    await request(serverFor(app)).get(`/api/reports/${r.id}/export-url?format=pdf`).set(as(other)).expect(404);
    await request(serverFor(app)).get(`/api/reports/${r.id}/export-url?format=doc`).set(as(emp)).expect(400);
  }, 60000);
});

// Checking a whole case at once, which is the difference between three minutes
// and twenty on a zip of thirty receipts.
describe('routes/reports — checking a case in bulk', () => {
  let app, users, store, reports, wf, admin, emp, tokens;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses');
    reports = require('../store/reports'); wf = require('../reports/workflow');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    emp   = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/reports', require('./reports'));
  });

  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const add = (c, extra = {}) => {
    const total = extra.total ?? 100;
    const e = store.createExpense({
      companyId: emp.companyId, userId: emp.id, status: 'review-needed', merchant: 'Grab', currency: 'SGD',
      total, receiptDate: '2026-09-04',
      lines: [{ category: 'Other', amount: total, baseAmount: total, fxRate: 1, fxSource: 'base', fxRateDate: '2026-09-04' }],
      ...extra,
    });
    reports.addExpense(c.id, e.id);
    return e;
  };

  // The route validated the kind separately from the store, and was not told
  // about cases — so every case created through the UI was refused by its own
  // route while the store, the schema and the printed cover all accepted one.
  test('a case can be created through the route that creates reports', async () => {
    const r = await request(serverFor(app)).post('/api/reports').set(as(emp)).send({ kind: 'case', title: 'Chakan job' }).expect(201);
    expect(r.body.report.kind).toBe('case');
    await request(serverFor(app)).post('/api/reports').set(as(emp)).send({ kind: 'trip', title: 'India' }).expect(201);
    await request(serverFor(app)).post('/api/reports').set(as(emp)).send({ kind: 'period', title: 'September' }).expect(201);
    await request(serverFor(app)).post('/api/reports').set(as(emp)).send({ kind: 'banana', title: 'No' }).expect(400);
  });

  test('everything that can be checked is, and everything else says why', async () => {
    const c = reports.createReport({ companyId: emp.companyId, userId: emp.id, kind: 'case', title: 'September receipts' });
    const good1 = add(c);
    const good2 = add(c, { merchant: 'Gojek', total: 25 });
    const noMerchant = add(c, { merchant: null });
    const stillReading = add(c, { status: 'reading' });
    const dup = add(c, { status: 'duplicate' });

    const res = await request(serverFor(app)).post(`/api/reports/${c.id}/review-all`).set(as(emp)).expect(200);

    expect(res.body.reviewed).toBe(2);
    expect(store.getExpense(good1.id).status).toBe('reviewed');
    expect(store.getExpense(good2.id).status).toBe('reviewed');
    const why = Object.fromEntries(res.body.skipped.map(s => [s.id, s.why]));
    expect(why[noMerchant.id]).toMatch(/merchant/);
    expect(why[stillReading.id]).toMatch(/still being read/);
    expect(why[dup.id]).toMatch(/duplicate/);
    expect(store.getExpense(dup.id).status).toBe('duplicate');
  });

  test('an expense belonging to somebody else is never marked reviewed', async () => {
    const c = reports.createReport({ companyId: emp.companyId, userId: emp.id, kind: 'case', title: 'c' });
    const mine = add(c);
    // however it got in there, this loop must not launder it into the claim
    const theirs = store.createExpense({ companyId: admin.companyId, userId: admin.id, status: 'review-needed', merchant: 'Raffles Hotel',
      currency: 'SGD', total: 900, receiptDate: '2026-09-04',
      lines: [{ category: 'Lodging', amount: 900, baseAmount: 900, fxRate: 1, fxSource: 'base', fxRateDate: '2026-09-04' }] });
    reports.addExpense(c.id, theirs.id);

    const res = await request(serverFor(app)).post(`/api/reports/${c.id}/review-all`).set(as(emp)).expect(200);
    expect(res.body.reviewed).toBe(1);
    expect(store.getExpense(mine.id).status).toBe('reviewed');
    expect(store.getExpense(theirs.id).status).toBe('review-needed');
    expect(res.body.skipped.find(s => s.id === theirs.id).why).toMatch(/belongs to someone else/);
  });

  test('checking a case leaves a trace in its history', async () => {
    const c = reports.createReport({ companyId: emp.companyId, userId: emp.id, kind: 'case', title: 'c' });
    add(c);
    await request(serverFor(app)).post(`/api/reports/${c.id}/review-all`).set(as(emp)).expect(200);
    const kinds = reports.getReport(c.id).events.map(e => e.kind || e.type || e.action);
    expect(kinds).toContain('checked');
  });

  test('lines that do not add up are left alone', async () => {
    const c = reports.createReport({ companyId: emp.companyId, userId: emp.id, kind: 'case', title: 'c' });
    const e = add(c, { total: 100 });
    store.replaceLines(e.id, [{ category: 'Other', amount: 40, currency: 'SGD' }], { force: true });
    const res = await request(serverFor(app)).post(`/api/reports/${c.id}/review-all`).set(as(emp)).expect(200);
    expect(res.body.reviewed).toBe(0);
    expect(res.body.skipped[0].why).toMatch(/do not add up/);
  });

  test('somebody else\'s case, and a claimed one, are refused', async () => {
    const mine = reports.createReport({ companyId: emp.companyId, userId: emp.id, kind: 'case', title: 'mine' });
    add(mine, { status: 'reviewed' });
    await request(serverFor(app)).post(`/api/reports/${mine.id}/review-all`).set(as(admin)).expect(200);  // an admin may

    wf.markClaimed(mine.id, emp);
    await request(serverFor(app)).post(`/api/reports/${mine.id}/review-all`).set(as(emp)).expect(409);
  });
});
