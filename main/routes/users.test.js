const request = require('supertest');
const express = require('express');
const { serverFor } = require('../scripts/test-server');

describe('routes/users and routes/company', () => {
  let app, admin, token;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
    app.use('/api/users', require('./users'));
    app.use('/api/company', require('./company'));
    const reg = await request(serverFor(app)).post('/api/auth/register').send({ email: 'wk@solv.sg', password: 'password123' });
    admin = reg.body.user; token = reg.body.token;
  });
  const as = t => ({ Authorization: `Bearer ${t}` });

  test('admin creates staff as users or admins; a user can neither create staff nor list them', async () => {
    const m = await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'm@solv.sg', password: 'password123', name: 'Henry', role: 'admin' }).expect(201);
    expect(m.body.user.role).toBe('admin');
    const e = await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'e@solv.sg', password: 'password123', name: 'Aisha', department: 'Sales' }).expect(201);
    expect(e.body.user.role).toBe('user');
    await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'x@solv.sg', password: 'password123', role: 'manager' }).expect(400);
    const login = await request(serverFor(app)).post('/api/auth/login').send({ email: 'e@solv.sg', password: 'password123' });
    await request(serverFor(app)).post('/api/users').set(as(login.body.token)).send({ email: 'x@solv.sg', password: 'password123' }).expect(403);
    // The staff list is an admin's: colleagues' names and emails are not a
    // user's to read.
    await request(serverFor(app)).get('/api/users').set(as(login.body.token)).expect(403);
    const list = await request(serverFor(app)).get('/api/users').set(as(token)).expect(200);
    expect(list.body.users.map(u => u.email).sort()).toEqual(['e@solv.sg', 'm@solv.sg', 'wk@solv.sg']);
    await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'short@solv.sg', password: 'short12' }).expect(400);   // 8 at least
  });

  test('removing a person ends their access and keeps their records; restore brings them back; the last admin stays', async () => {
    const e = (await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'e@solv.sg', password: 'password123' }).expect(201)).body.user;
    const login = await request(serverFor(app)).post('/api/auth/login').send({ email: 'e@solv.sg', password: 'password123' }).expect(200);
    const store = require('../store/expenses');
    store.createExpense({ companyId: e.companyId, userId: e.id, status: 'review-needed', merchant: 'Grab', currency: 'SGD', total: 10, lines: [{ category: 'Meals', amount: 10 }] });

    await request(serverFor(app)).delete(`/api/users/${admin.id}`).set(as(token)).expect(400);           // not yourself
    const gone = await request(serverFor(app)).delete(`/api/users/${e.id}`).set(as(token)).expect(200);
    expect(gone.body.user.removed).toBe(true);
    expect(store.listExpenses({ userId: e.id })).toHaveLength(1);                                         // records kept
    await request(serverFor(app)).get('/api/auth/me').set(as(login.body.token)).expect(401);              // session ended
    await request(serverFor(app)).post('/api/auth/login').send({ email: 'e@solv.sg', password: 'password123' }).expect(401);
    const again = await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'e@solv.sg', password: 'password123' }).expect(400);
    expect(again.body.error).toMatch(/removed account/);

    await request(serverFor(app)).post(`/api/users/${e.id}/restore`).set(as(token)).expect(200);
    await request(serverFor(app)).post('/api/auth/login').send({ email: 'e@solv.sg', password: 'password123' }).expect(200);

    // The only admin can be neither demoted nor removed.
    const r = await request(serverFor(app)).patch(`/api/users/${admin.id}`).set(as(token)).send({ role: 'user' }).expect(400);
    expect(r.body.error).toMatch(/only admin/);
  });

  test('a new password ends every other session and hands this device a fresh one', async () => {
    const old = token;
    const r = await request(serverFor(app)).post(`/api/users/${admin.id}/password`).set(as(old)).send({ currentPassword: 'password123', password: 'a-new-password' }).expect(200);
    expect(r.body.token).toBeTruthy();
    await request(serverFor(app)).get('/api/auth/me').set(as(old)).expect(401);
    await request(serverFor(app)).get('/api/auth/me').set(as(r.body.token)).expect(200);
  });

  test('company settings are readable by all and writable by an admin; reader keys are masked', async () => {
    const c = await request(serverFor(app)).get('/api/company').set(as(token)).expect(200);
    expect(c.body.company.baseCurrency).toBe('SGD');
    expect(c.body.categories).toContain('Lodging');
    await request(serverFor(app)).patch('/api/company').set(as(token)).send({ name: 'Solv Pte Ltd', reportColumns: ['Lodging', 'Meals', 'Other'] }).expect(200);
    await request(serverFor(app)).patch('/api/company').set(as(token)).send({ fxPolicy: 'bogus' }).expect(400);
    await request(serverFor(app)).post('/api/company/llm-keys').set(as(token)).send({ apiKey: 'AIzaSy-1234567890', label: 'main' }).expect(201);
    const keys = await request(serverFor(app)).get('/api/company/llm-keys').set(as(token)).expect(200);
    expect(keys.body.keys[0].keyMasked).toMatch(/••••/);
    expect(JSON.stringify(keys.body)).not.toContain('AIzaSy-1234567890');
  });

  test('the base currency can change before the first receipt is priced, never after', async () => {
    await request(serverFor(app)).patch('/api/company').set(as(token)).send({ baseCurrency: 'MYR' }).expect(200);
    await request(serverFor(app)).patch('/api/company').set(as(token)).send({ baseCurrency: 'SGD' }).expect(200);
    const store = require('../store/expenses');
    store.createExpense({ companyId: admin.companyId, userId: admin.id, status: 'reviewed', merchant: 'Grab', currency: 'SGD', total: 10, receiptDate: '2026-09-04',
      lines: [{ category: 'Meals', amount: 10, baseAmount: 10, fxRate: 1, fxSource: 'base' }] });
    const r = await request(serverFor(app)).patch('/api/company').set(as(token)).send({ baseCurrency: 'USD' }).expect(409);
    expect(r.body.error).toMatch(/cannot change once receipts have been converted to SGD/);
    await request(serverFor(app)).patch('/api/company').set(as(token)).send({ baseCurrency: 'SGD', name: 'Solv' }).expect(200);   // the same one is fine
  });

  test('a company LLM key can be tested, the answer is kept on the key, and the list says which models read', async () => {
    const axios = require('axios');
    const post = jest.spyOn(axios, 'post');
    await request(serverFor(app)).post('/api/company/llm-keys').set(as(token)).send({}).expect(400);
    const add = await request(serverFor(app)).post('/api/company/llm-keys').set(as(token)).send({ apiKey: 'AQ.Ab-test-key-0001', label: 'main' }).expect(201);

    post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'pong' } }] } });
    const ok = await request(serverFor(app)).post(`/api/company/llm-keys/${add.body.id}/test`).set(as(token)).expect(200);
    expect(ok.body).toMatchObject({ ok: true, model: expect.any(String), latencyMs: expect.any(Number) });
    let list = (await request(serverFor(app)).get('/api/company/llm-keys').set(as(token)).expect(200)).body;
    expect(list.models.length).toBeGreaterThan(0);
    expect(typeof list.fallbackKey).toBe('boolean');
    expect(list.keys[0]).toMatchObject({ lastOkAt: expect.any(String), lastModel: ok.body.model, lastError: null });

    post.mockRejectedValueOnce(Object.assign(new Error('unauthorised'), { response: { status: 401 } }));
    const bad = await request(serverFor(app)).post(`/api/company/llm-keys/${add.body.id}/test`).set(as(token)).expect(400);
    expect(bad.body.error).toMatch(/Invalid Gemini API key/);
    list = (await request(serverFor(app)).get('/api/company/llm-keys').set(as(token)).expect(200)).body;
    expect(list.keys[0]).toMatchObject({ lastErrorAt: expect.any(String), lastError: expect.stringMatching(/Invalid/) });

    await request(serverFor(app)).post('/api/company/llm-keys/99999/test').set(as(token)).expect(404);
    post.mockRestore();
  });

  test('a personal key test writes its answer only onto the caller\'s own key', async () => {
    const axios = require('axios');
    const post = jest.spyOn(axios, 'post');
    await request(serverFor(app)).post('/api/users/me/gemini-keys').set(as(token)).send({}).expect(400);
    const mine = await request(serverFor(app)).post('/api/users/me/gemini-keys').set(as(token)).send({ apiKey: 'AQ.Ab-personal-0001' }).expect(201);
    post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'pong' } }] } });
    await request(serverFor(app)).post('/api/users/me/gemini-keys/test').set(as(token)).send({ keyId: mine.body.id }).expect(200);
    const keys = (await request(serverFor(app)).get('/api/users/me/gemini-keys').set(as(token)).expect(200)).body.keys;
    expect(keys[0].lastOkAt).toEqual(expect.any(String));
    // Someone else's key id is not found, and nothing is tested or written.
    await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'o@solv.sg', password: 'password123' }).expect(201);
    const other = await request(serverFor(app)).post('/api/auth/login').send({ email: 'o@solv.sg', password: 'password123' });
    await request(serverFor(app)).post('/api/users/me/gemini-keys/test').set(as(other.body.token)).send({ keyId: mine.body.id }).expect(400);
    post.mockRestore();
  });
  test('company settings are checked: currency, time zone, report columns, registration switch', async () => {
    const patch = body => request(serverFor(app)).patch('/api/company').set(as(token)).send(body);
    await patch({ baseCurrency: 'ZZZ' }).expect(400);
    const tz = await patch({ timezone: 'asia/singapore' }).expect(200);
    expect(tz.body.company.timezone).toBe('Asia/Singapore');
    await patch({ timezone: '+08:00' }).expect(400);
    await patch({ timezone: 'Mars/Olympus' }).expect(400);
    const cols = await patch({ reportColumns: ['meals', 'Meals', 'Lodging'] }).expect(200);
    expect(cols.body.company.reportColumns).toEqual(['Meals', 'Lodging']);
    await patch({ reportColumns: ['Snacks'] }).expect(400);
    await patch({ reportColumns: [] }).expect(400);
    await patch({ allowRegistration: 'true' }).expect(400);
    await patch({ allowRegistration: true }).expect(200);
  });

  test('the company says when its base currency is locked', async () => {
    let c = await request(serverFor(app)).get('/api/company').set(as(token)).expect(200);
    expect(c.body.company.baseCurrencyLocked).toBe(false);
    const store = require('../store/expenses');
    store.createExpense({ companyId: admin.companyId, userId: admin.id, status: 'reviewed', currency: 'SGD', total: 5, lines: [{ category: 'Meals', amount: 5, baseAmount: 5, fxRate: 1 }] });
    c = await request(serverFor(app)).get('/api/company').set(as(token)).expect(200);
    expect(c.body.company.baseCurrencyLocked).toBe(true);
  });
  // "Change my password" checked the current one with no limit: a stolen
  // session could guess it at 500 requests a quarter-hour and keep the account.
  test('changing your own password shares the sign-in lock, and an admin reset lifts it', async () => {
    const m = (await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'm@solv.sg', password: 'password123' }).expect(201)).body.user;
    const mt = (await request(serverFor(app)).post('/api/auth/login').send({ email: 'm@solv.sg', password: 'password123' }).expect(200)).body.token;
    for (let i = 0; i < 10; i++) await request(serverFor(app)).post(`/api/users/${m.id}/password`).set(as(mt)).send({ currentPassword: 'guess-' + i, password: 'new-password-1' }).expect(403);
    await request(serverFor(app)).post(`/api/users/${m.id}/password`).set(as(mt)).send({ currentPassword: 'password123', password: 'new-password-1' }).expect(429);
    await request(serverFor(app)).post('/api/auth/login').send({ email: 'm@solv.sg', password: 'password123' }).expect(429);
    // The admin sets a new one: the lock goes with the old password.
    await request(serverFor(app)).post(`/api/users/${m.id}/password`).set(as(token)).send({ password: 'from-the-admin' }).expect(200);
    await request(serverFor(app)).post('/api/auth/login').send({ email: 'm@solv.sg', password: 'from-the-admin' }).expect(200);
  });

  test('employee id and department are set by an admin, not by the person themselves', async () => {
    const e = (await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'e@solv.sg', password: 'password123', employeeId: 'S0007' }).expect(201)).body.user;
    const et = (await request(serverFor(app)).post('/api/auth/login').send({ email: 'e@solv.sg', password: 'password123' }).expect(200)).body.token;
    const self = await request(serverFor(app)).patch(`/api/users/${e.id}`).set(as(et)).send({ name: 'Aisha', employeeId: 'CEO-0001', department: 'Board' }).expect(200);
    expect(self.body.user).toMatchObject({ name: 'Aisha', employeeId: 'S0007' });
    const byAdmin = await request(serverFor(app)).patch(`/api/users/${e.id}`).set(as(token)).send({ employeeId: 'S0008', department: 'Sales' }).expect(200);
    expect(byAdmin.body.user).toMatchObject({ employeeId: 'S0008', department: 'Sales' });
  });
});
