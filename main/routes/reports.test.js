const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.01341, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: '2026-09-18T03:00:00.000Z' }) }));

describe('routes/reports', () => {
  let app, users, store, admin, mgr, fin, emp, other, tokens;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'Admin' });
    mgr = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: admin.companyId, role: 'manager', name: 'Henry Bennett' });
    fin = await users.createUser({ email: 'f@solv.sg', password: 'password123', companyId: admin.companyId, role: 'finance', name: 'Fin' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, managerId: mgr.id, name: 'Elaine Khoo', department: 'Sales', employeeId: 'S0042' });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, mgr, fin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
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
    const view = await request(serverFor(app)).get(`/api/reports/${r.id}`).set(as(mgr)).expect(200);
    expect(view.body).toMatchObject({ editable: true, isOwner: false, canDecide: false });
  });

  test('the full journey: submit, manager approves, finance pays; wrong actors are refused; locked expenses', async () => {
    const r = (await create(emp)).body.report; const e = reviewed(emp);
    await request(serverFor(app)).post(`/api/reports/${r.id}/expenses`).set(as(emp)).send({ expenseIds: [e.id] });
    await request(serverFor(app)).post(`/api/reports/${r.id}/approve`).set(as(mgr)).expect(400);          // not submitted yet
    const s = await request(serverFor(app)).post(`/api/reports/${r.id}/submit`).set(as(emp)).expect(200);
    expect(s.body.report.status).toBe('submitted');
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ purpose: 'x' }).expect(409);
    await request(serverFor(app)).patch(`/api/reports/${r.id}`).set(as(emp)).send({ title: 'x' }).expect(409);
    await request(serverFor(app)).post(`/api/reports/${r.id}/approve`).set(as(other)).expect(404);       // not theirs to see
    await request(serverFor(app)).post(`/api/reports/${r.id}/approve`).set(as(emp)).expect(403);
    const q = await request(serverFor(app)).get('/api/reports/queue').set(as(mgr)).expect(200);
    expect(q.body.reports.map(x => x.id)).toEqual([r.id]);
    const a = await request(serverFor(app)).post(`/api/reports/${r.id}/approve`).set(as(mgr)).expect(200);
    expect(a.body.report).toMatchObject({ status: 'approved', approvedBy: mgr.id });
    await request(serverFor(app)).post(`/api/reports/${r.id}/paid`).set(as(mgr)).expect(403);
    const fq = await request(serverFor(app)).get('/api/reports/queue').set(as(fin)).expect(200);
    expect(fq.body.reports.map(x => x.id)).toEqual([r.id]);
    const p = await request(serverFor(app)).post(`/api/reports/${r.id}/paid`).set(as(fin)).expect(200);
    expect(p.body.report.status).toBe('paid');
    expect(p.body.report.events.map(x => x.action)).toEqual(['created', 'submitted', 'approved', 'paid']);
  });

  test('reject sends it back with a reason; the owner can edit and resubmit', async () => {
    const r = (await create(emp)).body.report; const e = reviewed(emp);
    await request(serverFor(app)).post(`/api/reports/${r.id}/expenses`).set(as(emp)).send({ expenseIds: [e.id] });
    await request(serverFor(app)).post(`/api/reports/${r.id}/submit`).set(as(emp)).expect(200);
    await request(serverFor(app)).post(`/api/reports/${r.id}/reject`).set(as(mgr)).send({}).expect(400);
    const rj = await request(serverFor(app)).post(`/api/reports/${r.id}/reject`).set(as(mgr)).send({ reason: 'Add the purpose' }).expect(200);
    expect(rj.body.report).toMatchObject({ status: 'rejected', rejectedReason: 'Add the purpose' });
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ purpose: 'Client visit' }).expect(200);
    await request(serverFor(app)).post(`/api/reports/${r.id}/submit`).set(as(emp)).expect(200);
  });

  test('listing: own for employees, direct reports for managers, all for finance; drafts can be deleted', async () => {
    const mine = (await create(emp)).body.report; await create(other);
    expect((await request(serverFor(app)).get('/api/reports').set(as(emp)).expect(200)).body.reports.map(r => r.id)).toEqual([mine.id]);
    expect((await request(serverFor(app)).get('/api/reports?scope=team').set(as(mgr)).expect(200)).body.reports.map(r => r.id)).toEqual([mine.id]);
    expect((await request(serverFor(app)).get('/api/reports?scope=all').set(as(fin)).expect(200)).body.reports).toHaveLength(2);
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
