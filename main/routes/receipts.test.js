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
