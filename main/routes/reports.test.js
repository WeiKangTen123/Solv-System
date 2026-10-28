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
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, name: 'Aisha Rahman', department: 'Sales', employeeId: 'S0001' });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/reports', require('./reports')); app.use('/api/expenses', require('./expenses'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const reviewed = (owner, extra = {}) => store.createExpense({ companyId: owner.companyId, userId: owner.id, status: 'reviewed', currency: 'INR', total: 100, receiptDate: '2026-09-04', merchant: 'Courtyard',
    lines: [{ category: 'Lodging', amount: 100, baseAmount: 1.34, fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }], ...extra });
  const create = (u, body = { title: 'India trip', purpose: 'Client visits', periodFrom: '2026-08-31', periodTo: '2026-09-04', destination: 'Pune' }) => request(serverFor(app)).post('/api/reports').set(as(u)).send(body);

  // Working case-first, a receipt is filed as it arrives and checked in the
  // case, so filing no longer asks whether it has been checked.
  test('create, file expenses, read back with totals; only the owner\'s own can be filed, checked or not', async () => {
    const r = (await create(emp).expect(201)).body.report;
    expect(r.number).toMatch(/^EXP-\d{4}-0001$/);
    const e1 = reviewed(emp), e2 = reviewed(other), e3 = reviewed(emp, { status: 'review-needed' });
    const filed = await request(serverFor(app)).post(`/api/reports/${r.id}/expenses`).set(as(emp)).send({ expenseIds: [e1.id, e2.id, e3.id, 'nope', { id: 1 }] }).expect(200);
    expect(filed.body.report.expenses.map(e => e.id).sort()).toEqual([e1.id, e3.id].sort());
    expect(filed.body.skipped).toEqual([{ id: e2.id, why: 'not found' }, { id: 'nope', why: 'not found' }, { id: { id: 1 }, why: 'not found' }]);
    expect(filed.body.report.totals.totalBase).toBe(2.68);
    await request(serverFor(app)).delete(`/api/reports/${r.id}/expenses/${e3.id}`).set(as(emp)).expect(200);
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
    // ai_details: the AI counted the nights from the case's dates when the receipt went in
    expect(p.body.report.events.map(x => x.action)).toEqual(['created', 'ai_details', 'claimed']);
    // claiming the case claimed what was in it, and locked it
    const claimed = await request(serverFor(app)).get(`/api/expenses/${e.id}`).set(as(emp)).expect(200);
    expect(claimed.body.expense.claimed).toBe(true);
    // the details stay correctable after the claim; deleting the receipt does not
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ purpose: 'x' }).expect(200);
    await request(serverFor(app)).delete(`/api/expenses/${e.id}`).set(as(emp)).expect(409);
    await request(serverFor(app)).patch(`/api/reports/${r.id}`).set(as(emp)).send({ title: 'x' }).expect(409);
    await request(serverFor(app)).post(`/api/reports/${r.id}/claimed`).set(as(emp)).expect(409);         // already
    // reopening is the owner's alone — an admin sees the case but does not
    // handle it — and frees the receipts again
    await request(serverFor(app)).post(`/api/reports/${r.id}/reopen`).set(as(other)).expect(404);
    await request(serverFor(app)).get(`/api/reports/${r.id}`).set(as(admin)).expect(200);
    await request(serverFor(app)).post(`/api/reports/${r.id}/reopen`).set(as(admin)).expect(403);
    await request(serverFor(app)).patch(`/api/reports/${r.id}`).set(as(admin)).send({ title: 'x' }).expect(403);
    const ro = await request(serverFor(app)).post(`/api/reports/${r.id}/reopen`).set(as(emp)).expect(200);
    expect(ro.body.report.status).toBe('open');
    expect(ro.body.report.events.map(x => x.action)).toEqual(['created', 'ai_details', 'claimed', 'edited', 'reopened']);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ purpose: 'Client visit' }).expect(200);
  });

  test('a case with an unchecked receipt cannot be claimed, and says so', async () => {
    const r = (await create(emp)).body.report;
    const e = reviewed(emp, { status: 'review-needed' });
    await request(serverFor(app)).post(`/api/reports/${r.id}/expenses`).set(as(emp)).send({ expenseIds: [e.id] }).expect(200);
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
  // An object as a title reached the database driver, whose message came back
  // as the error; "2026-13-45" was stored as a date.
  test('the cover takes text as text and dates that exist', async () => {
    await create(emp, { title: { a: 1 } }).expect(400);
    await create(emp, { title: 'Trip', periodFrom: '2026-13-45' }).expect(400);
    const later = await create(emp, { title: '  Next year  ', periodFrom: '2027-03-01', periodTo: '2027-03-05' }).expect(201);
    expect(later.body.report).toMatchObject({ title: 'Next year', periodTo: '2027-03-05' });
  });

  test('an advance must be a real amount', async () => {
    const r = (await create(emp).expect(201)).body.report;
    for (const advances of ['1e400', -1, 'abc', 1e9]) {
      await request(serverFor(app)).patch(`/api/reports/${r.id}`).set(as(emp)).send({ advances }).expect(400);
    }
    await request(serverFor(app)).patch(`/api/reports/${r.id}`).set(as(emp)).send({ advances: 250.5 }).expect(200);
  });

  // The phone dialog drops the case it made when nothing arrived, judged from
  // a poll up to three seconds old: a photo that landed since must keep it.
  test('?ifEmpty=1 keeps a case that has receipts in it', async () => {
    const r = (await create(emp).expect(201)).body.report;
    const e = reviewed(emp);
    await request(serverFor(app)).post(`/api/reports/${r.id}/expenses`).set(as(emp)).send({ expenseIds: [e.id] }).expect(200);
    const kept = await request(serverFor(app)).delete(`/api/reports/${r.id}?ifEmpty=1`).set(as(emp)).expect(409);
    expect(kept.body.kept).toBe(true);
    await request(serverFor(app)).get(`/api/reports/${r.id}`).set(as(emp)).expect(200);
    const empty = (await create(emp).expect(201)).body.report;
    await request(serverFor(app)).delete(`/api/reports/${empty.id}?ifEmpty=1`).set(as(emp)).expect(200);
  });

  // Claimed at the live rate, the day then closed higher; the close passes a
  // claimed receipt by. Reopened, it is priced as any open receipt is.
  test('reopening a case prices its receipts again', async () => {
    const r = (await create(emp).expect(201)).body.report;
    const e = reviewed(emp);
    await request(serverFor(app)).post(`/api/reports/${r.id}/expenses`).set(as(emp)).send({ expenseIds: [e.id] }).expect(200);
    await request(serverFor(app)).post(`/api/reports/${r.id}/claimed`).set(as(emp)).expect(200);
    require('../fx/rates').getRate.mockResolvedValueOnce({ rate: 0.0152, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: 'x', closedAt: 'y' });
    const back = await request(serverFor(app)).post(`/api/reports/${r.id}/reopen`).set(as(emp)).expect(200);
    expect(back.body.report.status).toBe('open');
    expect(back.body.report.expenses[0].lines[0]).toMatchObject({ fxRate: 0.0152, baseAmount: 1.52 });
  });

  // The claim window shows the declaration and says so; anything but a plain
  // true is a claim without it.
  test('a claim sent with the declaration records it; one without does not', async () => {
    const claim = async body => {
      const r = (await create(emp).expect(201)).body.report;
      await request(serverFor(app)).post(`/api/reports/${r.id}/expenses`).set(as(emp)).send({ expenseIds: [reviewed(emp).id] }).expect(200);
      return (await request(serverFor(app)).post(`/api/reports/${r.id}/claimed`).set(as(emp)).send(body).expect(200)).body.report.events.at(-1);
    };
    expect(await claim({ declared: true })).toMatchObject({ action: 'claimed', note: 'with the declaration' });
    expect(await claim({ declared: 'yes' })).toMatchObject({ action: 'claimed', note: null });
    expect(await claim({})).toMatchObject({ action: 'claimed', note: null });
  });
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
    await request(serverFor(app)).post(`/api/reports/${mine.id}/review-all`).set(as(admin)).expect(403);  // checking is the claimant's
    await request(serverFor(app)).post(`/api/reports/${mine.id}/review-all`).set(as(emp)).expect(200);

    wf.markClaimed(mine.id, emp);
    await request(serverFor(app)).post(`/api/reports/${mine.id}/review-all`).set(as(emp)).expect(409);
  });
});

// Receipts first: the New case page makes a draft when the first file lands,
// fills it as files arrive, and creates the case (with its number) at the end.
describe('routes/reports — drafts, merging, moving and the list', () => {
  let app, users, store, reports, db, admin, emp, other, tokens, year;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports'); db = require('../db');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/reports', require('./reports'));
    year = require('../utils/zone-date').localDate('Asia/Singapore').slice(0, 4);
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const api = () => request(serverFor(app));
  const receipt = (owner, extra = {}) => store.createExpense({ companyId: owner.companyId, userId: owner.id, status: 'review-needed', merchant: 'Grab', currency: 'SGD', total: 10,
    receiptDate: '2026-09-04', lines: [{ category: 'Other', amount: 10, baseAmount: 10, fxRate: 1, fxSource: 'base', fxRateDate: '2026-09-04' }], ...extra });
  const draft = async (u = emp, body = {}) => (await api().post('/api/reports').set(as(u)).send({ draft: true, ...body }).expect(201)).body.report;
  const fileIn = (r, ids, extra = {}, u = emp) => api().post(`/api/reports/${r.id}/expenses`).set(as(u)).send({ expenseIds: ids, ...extra });

  test('a draft has no number until it is created, and the number is taken then', async () => {
    const d = await draft();
    expect(d).toMatchObject({ number: null, status: 'draft', kind: 'case', coverAi: { auto: [], user: [] } });
    const open = (await api().post('/api/reports').set(as(emp)).send({ title: 'Open one' }).expect(201)).body.report;
    expect(open.number).toBe(`EXP-${year}-0001`);
    const view = await api().get(`/api/reports/${d.id}`).set(as(emp)).expect(200);
    expect(view.body).toMatchObject({ editable: true, isOwner: true, posted: false });

    await api().post(`/api/reports/${d.id}/open`).set(as(other)).expect(404);
    await api().post(`/api/reports/${d.id}/open`).set(as(admin)).expect(403);
    await api().post(`/api/reports/${d.id}/open`).set(as(emp)).send({ title: { a: 1 } }).expect(400);
    expect(reports.head(d.id).status).toBe('draft');                   // a refused create leaves it as it was

    const made = await api().post(`/api/reports/${d.id}/open`).set(as(emp)).send({ purpose: 'Client visits', kind: 'trip' }).expect(200);
    expect(made.body.report).toMatchObject({ number: `EXP-${year}-0002`, status: 'open', purpose: 'Client visits', kind: 'trip' });
    expect(made.body.report.title).toMatch(/^Receipts, /);
    expect(made.body.report.coverAi).toEqual({ auto: ['title'], user: ['kind', 'purpose'] });
    expect(made.body.report.events.map(e => e.action)).toEqual(['created', 'opened']);
    await api().post(`/api/reports/${d.id}/open`).set(as(emp)).expect(409);
    await api().post(`/api/reports/${open.id}/open`).set(as(emp)).expect(409);
  });

  test('cover fields sent when the draft is made, or edited later, are the owner\'s and the AI leaves them', async () => {
    const d = await draft(emp, { title: 'Pune visit' });
    expect(d.coverAi).toEqual({ auto: [], user: ['title'] });
    // a receipt filed in fills the rest of the cover
    await fileIn(d, [receipt(emp, { currency: 'INR', receiptDate: '2026-09-01' }).id]).expect(200);
    const filled = (await api().get(`/api/reports/${d.id}`).set(as(emp)).expect(200)).body.report;
    expect(filled).toMatchObject({ title: 'Pune visit', kind: 'trip', destination: 'India', periodFrom: '2026-09-01' });
    expect(filled.coverAi.auto).toEqual(expect.arrayContaining(['kind', 'destination', 'periodFrom']));
    const edited = await api().patch(`/api/reports/${d.id}`).set(as(emp)).send({ destination: 'Pune', kind: 'case' }).expect(200);
    expect(edited.body.report.coverAi.user).toEqual(['title', 'kind', 'destination']);
    expect(edited.body.report.coverAi.auto).not.toContain('destination');
    await fileIn(d, [receipt(emp, { currency: 'INR', receiptDate: '2026-09-05' }).id]).expect(200);
    const after = (await api().get(`/api/reports/${d.id}`).set(as(emp)).expect(200)).body.report;
    expect(after).toMatchObject({ title: 'Pune visit', destination: 'Pune', kind: 'case', periodTo: '2026-09-05', nights: 4 });
  });

  test('a draft cannot be claimed, reopened or exported', async () => {
    const d = await draft();
    const e = receipt(emp, { status: 'reviewed' });
    await fileIn(d, [e.id]).expect(200);
    const claim = await api().post(`/api/reports/${d.id}/claimed`).set(as(emp)).expect(409);
    expect(claim.body.error).toBe('Create the case before claiming it.');
    await api().post(`/api/reports/${d.id}/reopen`).set(as(emp)).expect(409);
    const exp = await api().get(`/api/reports/${d.id}/export-url?format=pdf`).set(as(emp)).expect(409);
    expect(exp.body.error).toMatch(/draft/);
    expect(reports.head(d.id).status).toBe('draft');
    expect(store.getExpense(e.id).claimed).toBe(false);
  });

  test('every receipt in the case view carries its flags', async () => {
    const d = await draft();
    await fileIn(d, [receipt(emp, { merchant: null }).id, receipt(emp, { status: 'reading', merchant: null }).id, receipt(emp).id]).expect(200);
    const view = await api().get(`/api/reports/${d.id}`).set(as(admin)).expect(200);
    const byMerchant = Object.fromEntries(view.body.report.expenses.map(e => [`${e.status}:${e.merchant}`, e.flags.map(f => f.code)]));
    expect(byMerchant).toEqual({ 'review-needed:null': ['no-merchant'], 'reading:null': [], 'review-needed:Grab': [] });
  });

  test('a receipt in another case moves only when asked to, and never out of a claimed one', async () => {
    const a = await draft(), b = await draft();
    const e = receipt(emp), dup = receipt(emp, { status: 'duplicate' }), alone = receipt(emp, { status: 'reviewed' });
    require('../reports/workflow').markExpenseClaimed(alone.id, emp);
    await fileIn(a, [e.id]).expect(200);
    const kept = await fileIn(b, [e.id, dup.id, alone.id]).expect(200);
    expect(kept.body.skipped).toEqual([{ id: e.id, why: 'already in another case' }, { id: dup.id, why: 'a duplicate' }, { id: alone.id, why: 'already claimed on its own' }]);
    const moved = await fileIn(b, [e.id], { move: true }).expect(200);
    expect(moved.body.report.expenses.map(x => x.id)).toEqual([e.id]);
    expect(moved.body.skipped).toEqual([]);
    expect(store.getExpense(e.id).reportId).toBe(b.id);
    // filing it where it already is changes nothing and says nothing
    expect((await fileIn(b, [e.id]).expect(200)).body.skipped).toEqual([]);
    // out of a claimed case it does not move, move or not
    const c = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'Claimed' });
    const locked = receipt(emp); reports.addExpense(c.id, locked.id);
    db.prepare("UPDATE expense_reports SET status = 'claimed' WHERE id = ?").run(c.id);
    expect((await fileIn(b, [locked.id], { move: true }).expect(200)).body.skipped).toEqual([{ id: locked.id, why: 'already in another case' }]);
    await fileIn(c, [e.id], { move: true }).expect(409);                // nor into one
    await fileIn(b, [e.id], {}, admin).expect(403);                     // an admin does not file anybody's
  });

  test('merging moves every receipt into the other case, says so there, and removes this one', async () => {
    const d = await draft();
    const e1 = receipt(emp), e2 = receipt(emp);
    await fileIn(d, [e1.id, e2.id]).expect(200);
    const trip = (await api().post('/api/reports').set(as(emp)).send({ title: 'Pune', periodFrom: '2026-09-01', periodTo: '2026-09-30' }).expect(201)).body.report;
    const out = await api().post(`/api/reports/${d.id}/merge`).set(as(emp)).send({ into: trip.id }).expect(200);
    expect(out.body.report.id).toBe(trip.id);
    expect(out.body.report.expenses.map(e => e.id).sort()).toEqual([e1.id, e2.id].sort());
    expect(out.body.report.events.at(-1)).toMatchObject({ action: 'edited', note: 'Merged 2 receipts from the draft "September 2026 claims"' });
    expect(out.body.report).toMatchObject({ title: 'Pune', periodFrom: '2026-09-01', periodTo: '2026-09-30' });   // the owner's cover stays
    await api().get(`/api/reports/${d.id}`).set(as(emp)).expect(404);
  });

  test('merging is refused for somebody else\'s case, a claimed one, itself, or nowhere', async () => {
    const d = await draft(), mine = await draft();
    const theirs = await draft(other);
    const claimed = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'Claimed' });
    db.prepare("UPDATE expense_reports SET status = 'claimed' WHERE id = ?").run(claimed.id);
    await api().post(`/api/reports/${d.id}/merge`).set(as(emp)).send({}).expect(400);
    await api().post(`/api/reports/${d.id}/merge`).set(as(emp)).send({ into: d.id }).expect(400);
    await api().post(`/api/reports/${d.id}/merge`).set(as(emp)).send({ into: 'nope' }).expect(404);
    await api().post(`/api/reports/${d.id}/merge`).set(as(emp)).send({ into: theirs.id }).expect(404);
    await api().post(`/api/reports/${d.id}/merge`).set(as(emp)).send({ into: claimed.id }).expect(409);
    await api().post(`/api/reports/${claimed.id}/merge`).set(as(emp)).send({ into: mine.id }).expect(409);
    await api().post(`/api/reports/${d.id}/merge`).set(as(admin)).send({ into: mine.id }).expect(403);
    await api().post(`/api/reports/${d.id}/merge`).set(as(other)).send({ into: mine.id }).expect(404);
    const adminsOwn = await draft(admin);
    await api().post(`/api/reports/${adminsOwn.id}/merge`).set(as(admin)).send({ into: mine.id }).expect(403);   // seeing is not owning
    expect([d, mine, theirs, claimed, adminsOwn].map(r => !!reports.head(r.id))).toEqual([true, true, true, true, true]);
  });

  test('a draft can be deleted with its receipts and their files; an open case cannot', async () => {
    const receiptStore = require('../receipts/receipt-store');
    const withFile = owner => {
      const file = receiptStore.forUser(owner.id).save(`f${Math.random().toString(36).slice(2)}`, Buffer.from('%PDF-1.4 test'), 'application/pdf');
      const rec = store.createReceipt({ companyId: owner.companyId, userId: owner.id, file, mime: 'application/pdf', sha256: file });
      return { e: receipt(owner, { receiptId: rec.id }), file, rec };
    };
    const open = (await api().post('/api/reports').set(as(emp)).send({ title: 'Open' }).expect(201)).body.report;
    const kept = withFile(emp);
    await fileIn(open, [kept.e.id]).expect(200);
    const refused = await api().delete(`/api/reports/${open.id}?withReceipts=1`).set(as(emp)).expect(409);
    expect(refused.body.error).toMatch(/Only a draft/);
    expect(store.getExpense(kept.e.id)).toBeTruthy();

    const d = await draft();
    const a = withFile(emp), b = withFile(emp);
    await fileIn(d, [a.e.id, b.e.id]).expect(200);
    await api().delete(`/api/reports/${d.id}?withReceipts=1`).set(as(admin)).expect(403);
    const gone = await api().delete(`/api/reports/${d.id}?withReceipts=1`).set(as(emp)).expect(200);
    expect(gone.body).toEqual({ ok: true, receiptsDeleted: 2 });
    expect(reports.head(d.id)).toBeNull();
    for (const x of [a, b]) {
      expect(store.getExpense(x.e.id)).toBeNull();
      expect(store.getReceipt(x.rec.id)).toBeNull();
      expect(receiptStore.forUser(emp.id).exists(x.file)).toBe(false);
    }
    expect(receiptStore.forUser(emp.id).exists(kept.file)).toBe(true);

    // without it, a draft's receipts are left outside any case
    const d2 = await draft(); const c = receipt(emp);
    await fileIn(d2, [c.id]).expect(200);
    await api().delete(`/api/reports/${d2.id}`).set(as(emp)).expect(200);
    expect(store.getExpense(c.id).reportId).toBeNull();
  });

  test('the list filters, searches, sorts and pages, and counts the scope', async () => {
    const d = await draft(emp, { title: 'Draft one' });
    const open = (await api().post('/api/reports').set(as(emp)).send({ title: 'Open trip', kind: 'trip' }).expect(201)).body.report;
    await fileIn(open, [receipt(emp, { status: 'reviewed', merchant: 'Courtyard Pune' }).id]).expect(200);
    const claimed = (await api().post('/api/reports').set(as(emp)).send({ title: 'Claimed month', kind: 'period' }).expect(201)).body.report;
    db.prepare("UPDATE expense_reports SET status = 'claimed', xero_invoice_id = 'INV-1' WHERE id = ?").run(claimed.id);
    await draft(other, { title: 'Theirs' });
    const list = q => api().get(`/api/reports${q}`).set(as(emp)).expect(200).then(r => r.body);
    const titles = body => body.reports.map(r => r.title);
    const counts = { draft: 1, open: 1, ready: 1, claimed: 1, all: 3 };

    const all = await list('');
    expect(all).toMatchObject({ total: 3, counts });
    expect(titles(all)).toHaveLength(3);
    expect(all.reports.find(r => r.id === open.id)).toMatchObject({ ready: true, reading: 0, expenseCount: 1 });
    expect(titles(await list('?status=draft'))).toEqual(['Draft one']);
    expect(titles(await list('?status=draft&status=claimed')).sort()).toEqual(['Claimed month', 'Draft one']);
    expect(titles(await list('?status=open,claimed&kind=period'))).toEqual(['Claimed month']);
    expect(titles(await list('?ready=1'))).toEqual(['Open trip']);
    expect(titles(await list('?posted=1'))).toEqual(['Claimed month']);
    expect(titles(await list('?q=courtyard'))).toEqual(['Open trip']);
    expect((await list('?q=courtyard')).counts).toEqual(counts);
    expect(titles(await list('?sort=oldest&limit=2'))).toEqual(['Draft one', 'Open trip']);
    expect(await list('?sort=oldest&limit=2&offset=2')).toMatchObject({ total: 3, reports: [{ title: 'Claimed month' }] });
    expect(titles(await list('?scope=all'))).not.toContain('Theirs');  // asking does not widen it

    const adminAll = await api().get('/api/reports?scope=all').set(as(admin)).expect(200);
    expect(adminAll.body).toMatchObject({ total: 4, counts: { all: 4, draft: 2 } });
    const one = await api().get(`/api/reports?scope=all&owner=${other.id}`).set(as(admin)).expect(200);
    expect(one.body).toMatchObject({ total: 1, counts: { all: 1, draft: 1 } });
    void d;
  });

  test('a list query the list does not understand is a 400 that says what it takes', async () => {
    for (const q of ['status=paid', 'status=,', 'status=open,x', 'kind=banana', 'sort=random', 'limit=0', 'limit=201', 'limit=2.5', 'limit=x', 'offset=-1', 'offset=a',
                     'ready=yes', 'posted=2', 'q[a]=1', 'q=a&q=b', 'sort=newest&sort=oldest']) {
      const res = await api().get(`/api/reports?${q}`).set(as(emp));
      expect([q, res.status]).toEqual([q, 400]);
      expect(res.body.error).toBeTruthy();
    }
    for (const q of ['limit=1', 'limit=200', 'offset=0', 'ready=0', 'posted=0', 'sort=dates', 'sort=amount', 'q=', 'kind=trip,case', 'status=draft,open,claimed', 'status=', 'status=open,,']) {
      await api().get(`/api/reports?${q}`).set(as(emp)).expect(200);
    }
  });
});
