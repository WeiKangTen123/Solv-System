const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('../receipts/receipt-parser', () => ({
  parseReceiptImage: jest.fn().mockResolvedValue(null), parseReceiptText: jest.fn().mockResolvedValue(null), parseReceiptPages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../pdf/render', () => ({ renderPdfPages: jest.fn().mockResolvedValue(null) }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 1, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'frankfurter', fetchedAt: 'x' }) }));

describe('routes/receipts', () => {
  let app, users, u, token, store, receiptStore, pairing, parser, routes;
  let _n = 0;
  const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ++_n]).toString('base64');

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses');
    receiptStore = require('../receipts/receipt-store'); pairing = require('../receipts/pairing'); pairing._reset();
    parser = require('../receipts/receipt-parser'); parser.parseReceiptImage.mockReset(); parser.parseReceiptImage.mockResolvedValue(null);
    routes = require('./receipts');
    u = await users.createUser({ email: `r${Date.now()}@solv.sg`, password: 'password123' });
    token = jwt.sign({ id: u.id, email: u.email, role: u.role }, require('../middleware/auth-middleware').jwtSecret());
    app = express(); app.use(express.json({ limit: '25mb' })); app.use('/api/receipts', routes);
  });
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const upload = body => request(serverFor(app)).post('/api/receipts').set(auth()).send(body);

  test('requires authentication', async () => { await request(serverFor(app)).post('/api/receipts').send({ mime: 'image/jpeg', data: jpeg() }).expect(401); });

  test('stores the file, creates an expense in reading, then review-needed once read', async () => {
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Grab', date: '2026-09-01', total: 18.4, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }] });
    const res = await upload({ mime: 'image/jpeg', data: jpeg(), filename: 'grab.jpg' }).expect(201);
    expect(res.body.expense.status).toBe('reading');
    expect(res.body.receipt.file).toMatch(/\.jpg$/);
    expect(res.body.imageToken).toBeTruthy();
    expect(receiptStore.forUser(u.id).exists(res.body.receipt.file)).toBe(true);
    await routes._drain();
    const after = store.getExpense(res.body.expense.id);
    expect(after.status).toBe('review-needed');
    expect(after.merchant).toBe('Grab');
    expect(after.lines[0]).toMatchObject({ category: 'Air & Transport', amount: 18.4 });
  });

  test('the same bytes twice are refused with a pointer to the first', async () => {
    const data = jpeg();
    const first = await upload({ mime: 'image/jpeg', data }).expect(201);
    const dup = await upload({ mime: 'image/jpeg', data }).expect(409);
    expect(dup.body.duplicateOf).toBe(first.body.expense.id);
  });

  test('rejects an unsupported type, an oversized file, and bad base64 without creating rows', async () => {
    await upload({ mime: 'image/heic', data: jpeg() }).expect(400);
    await upload({ mime: 'image/jpeg', data: Buffer.alloc(receiptStore.MAX_BYTES + 10, 1).toString('base64') }).expect(413);
    await upload({ mime: 'image/jpeg', data: 'not base64 !!!' }).expect(400);
    expect(store.listExpenses({ userId: u.id })).toHaveLength(0);
  });

  test('the image is served to a scoped token and refused without one', async () => {
    const { body } = await upload({ mime: 'image/jpeg', data: jpeg() });
    await request(serverFor(app)).get(`/api/receipts/${body.receipt.id}/image?token=${body.imageToken}`).expect(200).expect('Content-Type', /image\/jpeg/);
    await request(serverFor(app)).get(`/api/receipts/${body.receipt.id}/image`).expect(401);
    const t = await request(serverFor(app)).get(`/api/receipts/${body.receipt.id}/token`).set(auth()).expect(200);
    expect(t.body.token).toBeTruthy();
  });

  test('phone pairing: mint, check, upload without login, poll from both sides, revoke', async () => {
    const pair = await request(serverFor(app)).post('/api/receipts/pair').set(auth()).expect(201);
    expect(pair.body.qrSvg).toMatch(/<svg/);
    await request(serverFor(app)).get(`/api/receipts/capture/${pair.body.token}`).expect(200);
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Gojek', total: 25, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }] });
    const up = await request(serverFor(app)).post(`/api/receipts/capture/${pair.body.token}`).send({ mime: 'image/jpeg', data: jpeg() }).expect(201);
    expect(up.body.imageToken).toBeUndefined();
    await routes._drain();
    const phone = await request(serverFor(app)).get(`/api/receipts/capture/${pair.body.token}/status`).expect(200);
    expect(phone.body.receipts[0]).toMatchObject({ parsed: true, merchant: 'Gojek', total: 25 });
    const desk = await request(serverFor(app)).get(`/api/receipts/pair/${pair.body.token}`).set(auth()).expect(200);
    expect(desk.body.receipts[0].merchant).toBe('Gojek');
    expect(desk.body.receipts[0].imageToken).toBeTruthy();
    await request(serverFor(app)).delete(`/api/receipts/pair/${pair.body.token}`).set(auth()).expect(200);
    await request(serverFor(app)).get(`/api/receipts/capture/${pair.body.token}`).expect(401);
  });
});

// Working case-first: the case exists, and receipts are shot straight into it
// rather than landing in a pile to be filed later.
describe('routes/receipts — uploading into a case', () => {
  let app, users, store, reports, wf, routes, parser, owner, other, ownerTok, otherTok;
  let _n = 0;
  const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x11, ++_n]).toString('base64');

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses');
    reports = require('../store/reports'); wf = require('../reports/workflow');
    require('../receipts/pairing')._reset();
    parser = require('../receipts/receipt-parser');
    parser.parseReceiptImage.mockReset(); parser.parseReceiptImage.mockResolvedValue(null);
    routes = require('./receipts');
    // the first user of a company is its admin, and an admin may file into
    // anyone's case — so the people in this test are deliberately employees
    const boss = await users.createUser({ email: 'boss@solv.sg', password: 'password123' });
    owner = await users.createUser({ email: 'owner@solv.sg', password: 'password123', companyId: boss.companyId });
    other = await users.createUser({ email: 'other@solv.sg', password: 'password123', companyId: boss.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    ownerTok = jwt.sign({ id: owner.id, email: owner.email, role: owner.role }, secret);
    otherTok = jwt.sign({ id: other.id, email: other.email, role: other.role }, secret);
    app = express(); app.use(express.json({ limit: '25mb' })); app.use('/api/receipts', routes);
  });

  const as = t => ({ Authorization: `Bearer ${t}` });
  const newCase = (user = owner, extra = {}) =>
    reports.createReport({ companyId: user.companyId, userId: user.id, kind: 'case', title: 'Chakan job', ...extra });

  test('a receipt uploaded into a case is in it straight away, before anyone checks it', async () => {
    const c = newCase();
    const up = await request(serverFor(app)).post('/api/receipts').set(as(ownerTok))
      .send({ mime: 'image/jpeg', data: jpeg(), reportId: c.id }).expect(201);
    await routes._drain();

    const e = store.getExpense(up.body.expense.id);
    expect(e.reportId).toBe(c.id);
    expect(e.status).not.toBe('reviewed');                 // in the case, not yet checked
    const after = reports.getReport(c.id);
    expect(after.expenses).toHaveLength(1);
    expect(after.totals.unreviewed).toBe(1);
  });

  test('and the case still cannot be claimed until it has been checked', async () => {
    const c = newCase();
    await request(serverFor(app)).post('/api/receipts').set(as(ownerTok))
      .send({ mime: 'image/jpeg', data: jpeg(), reportId: c.id }).expect(201);
    await routes._drain();
    expect(() => wf.markClaimed(c.id, owner)).toThrow(/not checked/);
  });

  test('a case belonging to someone else, or already claimed, or absent, refuses the receipt', async () => {
    const theirs = newCase(other);
    await request(serverFor(app)).post('/api/receipts').set(as(ownerTok))
      .send({ mime: 'image/jpeg', data: jpeg(), reportId: theirs.id }).expect(403);

    const mine = newCase();
    const e = store.createExpense({ companyId: owner.companyId, userId: owner.id, status: 'reviewed', currency: 'SGD', total: 10,
      lines: [{ category: 'Other', amount: 10, baseAmount: 10, fxRate: 1, fxSource: 'base', fxRateDate: '2026-09-01' }] });
    reports.addExpense(mine.id, e.id);
    wf.markClaimed(mine.id, owner);
    await request(serverFor(app)).post('/api/receipts').set(as(ownerTok))
      .send({ mime: 'image/jpeg', data: jpeg(), reportId: mine.id }).expect(409);

    await request(serverFor(app)).post('/api/receipts').set(as(ownerTok))
      .send({ mime: 'image/jpeg', data: jpeg(), reportId: 'no-such-case' }).expect(404);
  });

  // The case was checked after the file had been written and the rows created,
  // so a refused upload answered 403 and left a stray expense in the pile with
  // the reader already running on it.
  test('a refused upload leaves nothing behind at all', async () => {
    const theirs = newCase(other);
    const before = store.listExpenses({ userId: owner.id }).length;
    const files = () => store.listExpenses({ userId: owner.id }).filter(e => e.receipt).length;
    const filesBefore = files();

    await request(serverFor(app)).post('/api/receipts').set(as(ownerTok))
      .send({ mime: 'image/jpeg', data: jpeg(), reportId: theirs.id }).expect(403);
    await request(serverFor(app)).post('/api/receipts').set(as(ownerTok))
      .send({ mime: 'image/jpeg', data: jpeg(), reportId: 'no-such-case' }).expect(404);
    await routes._drain();

    expect(store.listExpenses({ userId: owner.id })).toHaveLength(before);
    expect(files()).toBe(filesBefore);
    expect(reports.getReport(theirs.id).expenses).toHaveLength(0);
  });

  // The worst thing a case could do: an admin uploading into a claimant's case
  // created the expense under the ADMIN's name and filed it into the claimant's
  // report, so an admin's receipt became a line on someone else's reimbursement
  // that the claimant could not even open.
  test('not even an admin may put their own receipt in someone else\'s case', async () => {
    const boss = await users.createUser({ email: 'boss2@solv.sg', password: 'password123', companyId: owner.companyId, role: 'admin' });
    const bossTok = jwt.sign({ id: boss.id, email: boss.email, role: 'admin' }, require('../middleware/auth-middleware').jwtSecret());
    const theirs = newCase(owner);

    await request(serverFor(app)).post('/api/receipts').set({ Authorization: `Bearer ${bossTok}` })
      .send({ mime: 'image/jpeg', data: jpeg(), reportId: theirs.id }).expect(403);
    await routes._drain();

    expect(reports.getReport(theirs.id).expenses).toHaveLength(0);
    expect(store.listExpenses({ userId: boss.id })).toHaveLength(0);
  });

  test('a pairing cannot be opened for a case that is not yours', async () => {
    const theirs = newCase(other);
    await request(serverFor(app)).post('/api/receipts/pair').set(as(ownerTok)).send({ reportId: theirs.id }).expect(403);
    await request(serverFor(app)).post('/api/receipts/pair').set(as(ownerTok)).send({ reportId: 'nope' }).expect(404);
    // and the unauthenticated capture page therefore cannot echo a title you may not see
    const mine = newCase(owner);
    const ok = await request(serverFor(app)).post('/api/receipts/pair').set(as(ownerTok)).send({ reportId: mine.id }).expect(201);
    const page = await request(serverFor(app)).get(`/api/receipts/capture/${ok.body.token}`).expect(200);
    expect(page.body.case.id).toBe(mine.id);
  });

  test('a phone pairing opened for a case sends its photographs there', async () => {
    const c = newCase();
    const pair = await request(serverFor(app)).post('/api/receipts/pair').set(as(ownerTok)).send({ reportId: c.id }).expect(201);
    const seen = await request(serverFor(app)).get(`/api/receipts/capture/${pair.body.token}`).expect(200);
    expect(seen.body.reportId).toBe(c.id);                 // the phone knows which case it is filling

    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Grab', total: 18.4, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }] });
    await request(serverFor(app)).post(`/api/receipts/capture/${pair.body.token}`).send({ mime: 'image/jpeg', data: jpeg() }).expect(201);
    await routes._drain();

    const after = reports.getReport(c.id);
    expect(after.expenses).toHaveLength(1);
    expect(after.expenses[0].merchant).toBe('Grab');
    expect(after.expenses[0].source).toBe('phone');
  });

  test('a pairing opened for nothing in particular still goes to the loose pile', async () => {
    const pair = await request(serverFor(app)).post('/api/receipts/pair').set(as(ownerTok)).expect(201);
    await request(serverFor(app)).post(`/api/receipts/capture/${pair.body.token}`).send({ mime: 'image/jpeg', data: jpeg() }).expect(201);
    await routes._drain();
    const loose = store.listExpenses({ userId: owner.id, unfiled: true });
    expect(loose).toHaveLength(1);
    expect(loose[0].reportId).toBeFalsy();
  });
});
