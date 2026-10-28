const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.01341, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: '2026-09-18T03:00:00.000Z' }) }));

// GET /api/reports/:id/activity, and the case events the routes write for it.
describe('routes/activity', () => {
  let app, users, store, reports, changes, admin, emp, other, tokens;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports'); changes = require('../store/changes');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'Henry Admin' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, name: 'Aisha Rahman' });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId, name: 'Someone Else' });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    // As index.js mounts it: before the reports router, under the same prefix.
    app = express(); app.use(express.json());
    app.use('/api/reports', require('./activity')); app.use('/api/reports', require('./reports')); app.use('/api/expenses', require('./expenses'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const http = () => request(serverFor(app));
  const seed = (r, extra = {}) => store.createExpense({ companyId: emp.companyId, userId: emp.id, reportId: r.id, status: 'review-needed', merchant: 'Courtyard',
    currency: 'INR', total: 100, receiptDate: '2026-09-04', lines: [{ category: 'Lodging', amount: 100, baseAmount: 1.34, fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }], ...extra });
  const open = async () => (await http().post('/api/reports').set(as(emp)).send({ title: 'India trip', kind: 'trip', periodFrom: '2026-09-01', periodTo: '2026-09-04' }).expect(201)).body.report;
  const feed = async (r, u = emp, q = '') => (await http().get(`/api/reports/${r.id}/activity${q}`).set(as(u)).expect(200)).body;

  test('the owner and an admin of the company see it; nobody else, and nothing that is not there', async () => {
    const r = await open();
    expect((await feed(r)).items.map(x => x.text)).toEqual(['Created the case']);
    expect((await feed(r, admin)).items).toHaveLength(1);
    await http().get(`/api/reports/${r.id}/activity`).set(as(other)).expect(404);
    await http().get('/api/reports/nope/activity').set(as(emp)).expect(404);
    await http().get(`/api/reports/${r.id}/activity`).expect(401);
    await http().get(`/api/reports/${r.id}/activity?before=yesterday`).set(as(emp)).expect(400);
    await http().get(`/api/reports/${r.id}/activity?limit=0`).set(as(emp)).expect(400);
    await http().get(`/api/reports/${r.id}/activity?limit=x`).set(as(emp)).expect(400);
    const page = await feed(r, emp, `?limit=1&before=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`);
    expect(page).toEqual({ items: [expect.objectContaining({ action: 'created', actor: { type: 'person', id: emp.id, name: 'Aisha Rahman' } })], next: null });
  });

  test('a draft opened is "started" and "created", once each', async () => {
    const d = (await http().post('/api/reports').set(as(emp)).send({ draft: true }).expect(201)).body.report;
    await http().patch(`/api/reports/${d.id}`).set(as(emp)).send({ title: 'Mumbai' }).expect(200);
    await http().post(`/api/reports/${d.id}/open`).set(as(emp)).send({ purpose: 'Client visits' }).expect(200);
    expect((await feed(d)).items.map(x => x.text)).toEqual(['Created the case from the draft', 'Started a draft']);
  });

  test('the cover edited, receipts checked one by one and all at once, one taken out, one deleted: each said once, by whom', async () => {
    const r = await open();
    const [a, b, c, d] = ['Uber', 'Taj', 'Grab', 'Starbucks'].map(merchant => seed(r, { merchant }));
    await http().patch(`/api/reports/${r.id}`).set(as(emp)).send({ title: 'India and Pune' }).expect(200);
    await http().patch(`/api/reports/${r.id}`).set(as(emp)).send({ destination: 'Pune', title: 'India and Pune' }).expect(200);
    // an admin's correction is theirs, marked, where the owner sees it
    await http().patch(`/api/expenses/${b.id}`).set(as(admin)).send({ invoiceNo: 'F-12' }).expect(200);
    await http().patch(`/api/expenses/${a.id}/status`).set(as(emp)).send({ status: 'reviewed' }).expect(200);
    await http().patch(`/api/expenses/${b.id}/status`).set(as(emp)).send({ status: 'reviewed' }).expect(200);
    await http().post(`/api/reports/${r.id}/review-all`).set(as(emp)).expect(200);
    // taken out through the one rule for filing: its own log says so too
    await http().delete(`/api/reports/${r.id}/expenses/${c.id}`).set(as(emp)).expect(200);
    expect(changes.list(c.id)[0]).toMatchObject({ field: 'case', oldValue: r.number, newValue: null, actorId: emp.id });
    await http().delete(`/api/reports/${r.id}/expenses/${c.id}`).set(as(emp)).expect(404);
    await http().delete(`/api/expenses/${d.id}`).set(as(emp)).expect(200);

    const items = (await feed(r, admin)).items;
    // Taking a receipt out refreshes the cover from what is left, and the AI's
    // change to it (the trip's empty nights) is its own entry, said as the AI.
    expect(items.map(x => [x.actor.name, x.text])).toEqual([
      ['Aisha Rahman', 'Deleted Starbucks, INR 100.00, 4 Sep 2026'],
      ['AI', 'Updated the details from the receipts: Nights empty → 3'],
      ['Aisha Rahman', 'Took Grab, INR 100.00, 4 Sep 2026 out of the case'],
      ['Aisha Rahman', 'Checked 2 receipts'],
      ['Aisha Rahman', 'Checked 2 receipts'],
      ['Henry Admin', 'Edited Taj: invoice no. set to F-12'],
      ['Aisha Rahman', 'Edited the details: title and destination'],
      ['Aisha Rahman', 'Created the case'],
    ]);
    expect(items[1].actor).toMatchObject({ type: 'ai' });
    // the one-by-one run and "check all" are two events, each naming its own:
    // the deleted one is counted and, its log gone with it, no longer named
    expect(items[3].receipts.map(x => [x.merchant, x.inCase])).toEqual([['Grab', false]]);
    expect(items[4].receipts.map(x => x.merchant)).toEqual(['Uber', 'Taj']);
    expect(items[2]).toMatchObject({ receiptId: c.id, merchant: 'Grab' });
    expect(items[5].actor).toMatchObject({ type: 'person', role: 'admin' });
    expect(reports.listEvents(r.id).map(x => x.action)).toEqual(['created', 'details_edited', 'checked', 'checked', 'removed', 'ai_details', 'deleted']);
  });

  test('taking out keeps every rule filing has: the owner\'s, an open case, and a duplicate stays where it is', async () => {
    const r = await open();
    const e = seed(r), dup = seed(r, { status: 'duplicate' });
    await http().delete(`/api/reports/${r.id}/expenses/${e.id}`).set(as(admin)).expect(403);
    const refused = await http().delete(`/api/reports/${r.id}/expenses/${dup.id}`).set(as(emp)).expect(400);
    expect(refused.body.error).toMatch(/duplicate, so it cannot be taken out of its case\. Delete it/);
    expect(store.getExpense(dup.id).reportId).toBe(r.id);
    store.updateExpense(dup.id, { status: 'reviewed' });
    store.updateExpense(e.id, { status: 'reviewed' });
    await http().post(`/api/reports/${r.id}/claimed`).set(as(emp)).expect(200);
    await http().delete(`/api/reports/${r.id}/expenses/${e.id}`).set(as(emp)).expect(409);
    expect(reports.listEvents(r.id).map(x => x.action)).toEqual(['created', 'claimed']);
  });
});
