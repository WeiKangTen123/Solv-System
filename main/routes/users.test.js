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

  test('admin creates staff as users or admins; a user cannot create, and sees the short directory', async () => {
    const m = await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'm@solv.sg', password: 'password123', name: 'Henry', role: 'admin' }).expect(201);
    expect(m.body.user.role).toBe('admin');
    const e = await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'e@solv.sg', password: 'password123', name: 'Aisha', department: 'Sales' }).expect(201);
    expect(e.body.user.role).toBe('user');
    await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'x@solv.sg', password: 'password123', role: 'manager' }).expect(400);
    const login = await request(serverFor(app)).post('/api/auth/login').send({ email: 'e@solv.sg', password: 'password123' });
    await request(serverFor(app)).post('/api/users').set(as(login.body.token)).send({ email: 'x@solv.sg', password: 'password123' }).expect(403);
    const list = await request(serverFor(app)).get('/api/users').set(as(login.body.token)).expect(200);
    expect(list.body.users.map(u => u.email).sort()).toEqual(['e@solv.sg', 'm@solv.sg', 'wk@solv.sg']);
    expect(list.body.users[0].employeeId).toBeUndefined();   // the short directory shape
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
});
