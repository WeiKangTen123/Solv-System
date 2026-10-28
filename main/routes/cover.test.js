const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

// GET /:id/cover-suggestions and POST /:id/cover-ai (routes/cover.js), mounted
// as index.js mounts them: under /api/reports, before the case routes.
describe('routes/cover', () => {
  let app, users, store, reports, admin, emp, other, tokens;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'Admin' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, name: 'Aisha' });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json());
    app.use('/api/reports', require('./cover')); app.use('/api/reports', require('./reports'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const put = (c, receiptDate, extra = {}) => reports.addExpense(c.id, store.createExpense({ companyId: emp.companyId, userId: emp.id, status: 'review-needed', receiptDate, currency: 'INR', country: 'IN', ...extra }).id);
  const suggestions = (u, id) => request(serverFor(app)).get(`/api/reports/${id}/cover-suggestions`).set(as(u));
  const handBack = (u, id, fields) => request(serverFor(app)).post(`/api/reports/${id}/cover-ai`).set(as(u)).send({ fields });
  const trip = (extra = {}) => reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'Pune visit', kind: 'trip', periodFrom: '2026-09-01', periodTo: '2026-09-04',
                                                      destination: 'Pune', nights: 3, purpose: 'Site visits', ...extra });

  test('each field\'s suggestion beside what the case has, where it came from, and the purpose choices', async () => {
    const t = trip();
    put(t, '2026-08-31', { city: 'Mumbai', docType: 'hotel', lines: [{ category: 'Lodging', amount: 100 }] });
    put(t, '2026-09-02', { city: 'Pune', docType: 'ride', lines: [{ category: 'Air & Transport', amount: 10 }] });
    put(t, '2026-09-04', { city: 'Pune', docType: 'hotel', lines: [{ category: 'Lodging', amount: 100 }] });
    put(t, '2026-10-20', { currency: 'SGD', country: 'SG', city: 'Singapore' });          // seven weeks later
    reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'Before', purpose: 'Client visits in Chennai' });
    reports.createReport({ companyId: other.companyId, userId: other.id, title: 'Theirs', purpose: 'Somebody else\'s client' });

    const body = (await suggestions(emp, t.id).expect(200)).body;
    expect(body.fields).toEqual({ kind: 'trip', title: 'India trip, Aug–Sep 2026', periodFrom: '2026-08-31', periodTo: '2026-09-04', destination: 'Pune, Mumbai, India', nights: 4 });
    expect(body.current).toEqual({ kind: 'trip', title: 'Pune visit', periodFrom: '2026-09-01', periodTo: '2026-09-04', destination: 'Pune', nights: 3, purpose: 'Site visits' });
    expect(body.coverAi).toEqual({ auto: [], user: expect.arrayContaining(['kind', 'title', 'periodFrom', 'periodTo', 'destination', 'nights', 'purpose']) });
    expect(body.basis).toEqual({ receipts: 3, cities: ['Pune', 'Mumbai'], countries: ['India'], from: '2026-08-31', to: '2026-09-04' });
    expect(body.aiCanKeep).toEqual(['periodFrom', 'periodTo', 'destination', 'nights']);
    expect(body.purposeDraft).toBe('Hotel stays and local transport in Pune and Mumbai, 31 Aug – 4 Sep 2026');
    expect(body.pastPurposes).toEqual(['Client visits in Chennai']);

    // An admin monitoring sees the suggestion, not the person's other purposes.
    const seen = (await suggestions(admin, t.id).expect(200)).body;
    expect(seen.fields).toEqual(body.fields);
    expect(seen.pastPurposes).toEqual([]);
    await suggestions(other, t.id).expect(404);
    await suggestions(emp, 'nope').expect(404);
  });

  test('nothing read yet: no fields, no source line, no draft, and the past purposes all the same', async () => {
    const t = trip({ purpose: null });
    put(t, null, { status: 'reading' });
    reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'Before', purpose: 'Trade fair' });
    const body = (await suggestions(emp, t.id).expect(200)).body;
    expect(body).toMatchObject({ fields: null, basis: null, purposeDraft: null, pastPurposes: ['Trade fair'] });
  });

  test('handing fields back: the AI fills them from the receipts at once, and keeps them up', async () => {
    const t = trip();
    put(t, '2026-09-01', { city: 'Mumbai' }); put(t, '2026-09-06', { city: 'Pune' });
    const out = (await handBack(emp, t.id, ['periodFrom', 'periodTo', 'nights']).expect(200)).body;
    expect(out.changed.sort()).toEqual(['nights', 'periodTo']);
    expect(out.report).toMatchObject({ periodFrom: '2026-09-01', periodTo: '2026-09-06', nights: 5, destination: 'Pune', title: 'Pune visit' });
    expect(out.report.coverAi.auto.sort()).toEqual(['nights', 'periodFrom', 'periodTo']);
    expect(out.report.coverAi.user).not.toContain('periodTo');
    expect(out.report.coverAi.user).toContain('destination');
    expect(out.report.events.filter(e => e.action === 'ai_details').map(e => e.note)).toEqual(['Dates 1–4 Sep 2026 → 1–6 Sep 2026; nights 3 → 5']);
    // and from then on, as receipts land
    put(t, '2026-09-08', { city: 'Pune' });
    require('../reports/cover-auto').refresh(t.id);
    expect(reports.getReport(t.id)).toMatchObject({ periodTo: '2026-09-08', nights: 7 });
  });

  test('handing back is the owner\'s, on a case still taking edits, of fields the AI keeps', async () => {
    const t = trip();
    await handBack(admin, t.id, ['nights']).expect(403);
    await handBack(other, t.id, ['nights']).expect(404);
    expect((await handBack(emp, t.id, ['title']).expect(400)).body.error).toMatch(/only the dates, where and the nights/);
    expect((await handBack(emp, t.id, ['purpose']).expect(400)).body.error).toMatch(/purpose/);
    await handBack(emp, t.id, []).expect(400);
    await handBack(emp, t.id, 'nights').expect(400);
    await handBack(emp, t.id, [{ f: 1 }]).expect(400);
    const d = reports.createReport({ companyId: emp.companyId, userId: emp.id, draft: true, title: 'Mine' });
    put(d, '2026-09-01');
    const drafted = (await handBack(emp, d.id, ['title']).expect(200)).body;
    expect(drafted.report).toMatchObject({ title: 'India trip, Sep 2026', status: 'draft' });
    require('../db').prepare("UPDATE expense_reports SET status = 'claimed' WHERE id = ?").run(t.id);
    await handBack(emp, t.id, ['nights']).expect(409);
    expect((await suggestions(emp, t.id).expect(200)).body.aiCanKeep).toEqual([]);
  });

  test('taking a suggestion is a PATCH: the fields ticked become the owner\'s, the rest stay the AI\'s', async () => {
    const t = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'Pune', kind: 'trip' });
    put(t, '2026-09-01', { city: 'Pune' }); put(t, '2026-09-03', { city: 'Pune' });
    require('../reports/cover-auto').refresh(t.id);
    const s = (await suggestions(emp, t.id).expect(200)).body.fields;
    const r = (await request(serverFor(app)).patch(`/api/reports/${t.id}`).set(as(emp)).send({ title: s.title }).expect(200)).body.report;
    expect(r).toMatchObject({ title: 'India trip, Sep 2026', periodFrom: '2026-09-01', nights: 2 });
    expect(r.coverAi.user).toContain('title');
    expect(r.coverAi.auto.sort()).toEqual(['destination', 'nights', 'periodFrom', 'periodTo']);
  });

  // The "AI suggests" lines inside Edit read the intake poll's suggestion,
  // which offered an open Trip of local receipts "Month" and a whole month.
  test('the intake poll suggests for the kind the case is', async () => {
    const t = trip({ periodFrom: '2026-09-03', periodTo: '2026-09-05', destination: null, nights: null });
    put(t, '2026-09-03', { currency: 'SGD', country: 'SG' }); put(t, '2026-09-05', { currency: 'SGD', country: 'SG' });
    const s = (await request(serverFor(app)).get(`/api/reports/${t.id}/intake`).set(as(emp)).expect(200)).body.suggestion;
    expect(s).toMatchObject({ kind: 'trip', title: 'Trip, Sep 2026', periodFrom: '2026-09-03', periodTo: '2026-09-05', nights: 2 });
    expect(s.basis).toMatchObject({ receipts: 2, countries: ['Singapore'] });
  });
});
