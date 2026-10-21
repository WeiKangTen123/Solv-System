const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.0162, rateDate: '2026-09-02', providerDate: '2026-09-02', source: 'frankfurter', fetchedAt: '2026-09-18T03:00:00.000Z' }) }));

// GET /api/reports/:id/intake: what the New case page polls while receipts go
// in. The read jobs are written straight into the table and the queue is
// stopped, so each state is exactly the one the test set up.
describe('GET /api/reports/:id/intake', () => {
  let app, users, store, db, emp, admin, other, tokens;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    require('../receipts/read-queue').stop();
    users = require('../store/users'); store = require('../store/expenses'); db = require('../db');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'Admin' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, name: 'Aisha' });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/reports', require('./reports'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const get = (u, id) => request(serverFor(app)).get(`/api/reports/${id}/intake`).set(as(u));

  let n = 0;
  function file(caseId, { state, name, read = {}, at }) {
    n++;
    const receipt = store.createReceipt({ companyId: emp.companyId, userId: emp.id, file: `r${n}.jpg`, mime: 'image/jpeg', sizeBytes: 1000 + n, originalName: name, convertedFrom: name.endsWith('.HEIC') ? 'image/heic' : null });
    db.prepare('UPDATE receipts SET received_at = ? WHERE id = ?').run(at, receipt.id);
    const e = store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: receipt.id, reportId: caseId, status: state === 'done' ? 'review-needed' : 'reading', ...read });
    db.prepare(`INSERT INTO read_jobs (id, company_id, user_id, receipt_id, expense_id, state, attempts, next_at, error_kind, error, created_at, started_at, finished_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`job${n}`, emp.companyId, emp.id, receipt.id, e.id, state, state === 'failed' ? 5 : 1, at, state === 'failed' ? 'unavailable' : null,
           state === 'failed' ? 'The AI was busy.' : null, at, state === 'queued' ? null : at, state === 'done' || state === 'failed' ? at : null);
    return { receipt, e };
  }

  test('each file with its read, the counts, the AI\'s cover for a trip, and a wait while reads are queued', async () => {
    const draft = (await request(serverFor(app)).post('/api/reports').set(as(emp)).send({ draft: true }).expect(201)).body.report;
    file(draft.id, { state: 'done', name: 'IMG_1.HEIC', at: '2026-09-05T01:00:00.000Z',
      read: { merchant: 'Taj Mumbai', receiptDate: '2026-09-02', currency: 'INR', total: 18400, city: 'Mumbai', country: 'IN', docType: 'hotel' } });
    file(draft.id, { state: 'done', name: 'ola.pdf', at: '2026-09-05T01:00:01.000Z',
      read: { merchant: 'Ola', receiptDate: '2026-09-04', currency: 'INR', total: 640, city: 'Pune', country: 'IN', docType: 'ride' } });
    file(draft.id, { state: 'queued', name: 'IMG_3.jpg', at: '2026-09-05T01:00:02.000Z' });
    file(draft.id, { state: 'failed', name: 'scan.tiff', at: '2026-09-05T01:00:03.000Z' });

    const body = (await get(emp, draft.id).expect(200)).body;
    expect(body).toMatchObject({ caseId: draft.id, status: 'draft', number: null });
    expect(body.counts).toEqual({ files: 4, queued: 1, reading: 0, done: 2, failed: 1, receipts: 4, toCheck: 2 });
    // Oldest file first, the order they were sent in.
    expect(body.files.map(f => f.originalName)).toEqual(['IMG_1.HEIC', 'ola.pdf', 'IMG_3.jpg', 'scan.tiff']);
    expect(body.files[0]).toMatchObject({ convertedFrom: 'image/heic', read: { state: 'done' } });
    expect(body.files[0].expenses[0]).toMatchObject({ merchant: 'Taj Mumbai', city: 'Mumbai', country: 'IN', docType: 'hotel' });
    expect(Array.isArray(body.files[0].expenses[0].flags)).toBe(true);
    expect(body.files[3].read).toMatchObject({ state: 'failed', errorKind: 'unavailable', error: 'The AI was busy.' });
    expect(body.etaSeconds).toBeGreaterThan(0);
    expect(body.suggestion).toMatchObject({ kind: 'trip', periodFrom: '2026-09-02', periodTo: '2026-09-04' });
    expect(body.suggestion.title).toMatch(/India/);
    expect(body.suggestion.destination).toMatch(/Mumbai/);
    expect(body.coverAi).toEqual(expect.objectContaining({ auto: expect.any(Array), user: expect.any(Array) }));
    expect(body.match).toBeNull();
  });

  test('a draft whose receipts fall inside an open case\'s dates is offered that case', async () => {
    const trip = (await request(serverFor(app)).post('/api/reports').set(as(emp))
      .send({ title: 'India trip', kind: 'trip', periodFrom: '2026-09-01', periodTo: '2026-09-06' }).expect(201)).body.report;
    const draft = (await request(serverFor(app)).post('/api/reports').set(as(emp)).send({ draft: true }).expect(201)).body.report;
    file(draft.id, { state: 'done', name: 'a.jpg', at: '2026-09-05T01:00:00.000Z', read: { merchant: 'Cafe', receiptDate: '2026-09-03', currency: 'INR', total: 900 } });
    const body = (await get(emp, draft.id).expect(200)).body;
    expect(body.match).toMatchObject({ id: trip.id, number: trip.number, title: 'India trip' });
    expect(body.etaSeconds).toBe(0);
    // An open case is not offered somewhere else to go.
    expect((await get(emp, trip.id).expect(200)).body.match).toBeNull();
  });

  test('the owner and an admin may look; a colleague may not', async () => {
    const draft = (await request(serverFor(app)).post('/api/reports').set(as(emp)).send({ draft: true }).expect(201)).body.report;
    await get(other, draft.id).expect(404);
    await get(admin, draft.id).expect(200);
    await get(emp, 'nope').expect(404);
  });

  test('merging a draft into a case takes its phone link along', async () => {
    const trip = (await request(serverFor(app)).post('/api/reports').set(as(emp)).send({ title: 'Trip' }).expect(201)).body.report;
    const draft = (await request(serverFor(app)).post('/api/reports').set(as(emp)).send({ draft: true }).expect(201)).body.report;
    const pairing = require('../receipts/pairing');
    const token = pairing.create(emp.id, { reportId: draft.id });
    await request(serverFor(app)).post(`/api/reports/${draft.id}/merge`).set(as(emp)).send({ into: trip.id }).expect(200);
    expect(pairing.status(token).reportId).toBe(trip.id);
  });

  test('a read that lands brings the draft\'s cover up to date through the queue\'s hook', async () => {
    const draft = (await request(serverFor(app)).post('/api/reports').set(as(emp)).send({ draft: true }).expect(201)).body.report;
    const { receipt } = file(draft.id, { state: 'done', name: 'a.jpg', at: '2026-10-02T01:00:00.000Z',
      read: { merchant: 'Toast Box', receiptDate: '2026-10-02', currency: 'SGD', total: 8.47, country: 'SG', city: 'Singapore', docType: 'meal' } });
    const ids = require('../reports/cover-auto').refreshForReceipt(receipt.id);
    expect(ids).toEqual([draft.id]);
    const r = require('../store/reports').getReport(draft.id);
    expect(r).toMatchObject({ kind: 'period', periodFrom: '2026-10-01', periodTo: '2026-10-31' });
    expect(r.title).toMatch(/October 2026/);
    expect(r.coverAi.auto).toEqual(expect.arrayContaining(['kind', 'title', 'periodFrom', 'periodTo']));
  });
});
