const request = require('supertest');
const express = require('express');
const { serverFor } = require('../scripts/test-server');

describe('routes/auth', () => {
  let app;
  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
  });

  test('first registration is admin, returns a token, and /me carries the company', async () => {
    const reg = await request(serverFor(app)).post('/api/auth/register').send({ email: 'wk@solv.sg', password: 'password123', name: 'Wei Kang' }).expect(201);
    expect(reg.body.user.role).toBe('admin');
    const me = await request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${reg.body.token}`).expect(200);
    expect(me.body.user.baseCurrency).toBe('SGD');
    expect(me.body.user.companyName).toBe('Solv');
  });

  // The sign-in screen asks this to decide whether to offer a Register tab.
  // After the first account, registering is open only when an admin has
  // switched it on in Company settings. The environment variable that used to
  // decide it is no longer read.
  test('/status, and registering, follow the company switch, not the environment', async () => {
    const empty = await request(serverFor(app)).get('/api/auth/status').expect(200);
    expect(empty.body).toEqual({ hasUsers: false, registrationOpen: true });
    const first = await request(serverFor(app)).post('/api/auth/register').send({ email: 'a@solv.sg', password: 'password123' }).expect(201);

    process.env.ALLOW_REGISTRATION = 'true';
    const closed = await request(serverFor(app)).get('/api/auth/status').expect(200);
    expect(closed.body).toEqual({ hasUsers: true, registrationOpen: false });
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'b@solv.sg', password: 'password123' }).expect(403);
    delete process.env.ALLOW_REGISTRATION;

    require('../store/users').updateCompany(first.body.user.companyId, { allowRegistration: true });
    expect((await request(serverFor(app)).get('/api/auth/status').expect(200)).body.registrationOpen).toBe(true);
    const r = await request(serverFor(app)).post('/api/auth/register').send({ email: 'b@solv.sg', password: 'password123' }).expect(201);
    expect(r.body.user.role).toBe('user');
    expect(r.body.user.companyId).toBe(first.body.user.companyId);
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'c@solv.sg', password: 'short' }).expect(400);
  });

  test('login works with the right password and fails with the wrong one', async () => {
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'a@solv.sg', password: 'password123' }).expect(201);
    await request(serverFor(app)).post('/api/auth/login').send({ email: 'a@solv.sg', password: 'password123' }).expect(200);
    await request(serverFor(app)).post('/api/auth/login').send({ email: 'a@solv.sg', password: 'nope' }).expect(401);
  });

  test('signing out ends the session; an image or export link is never a login', async () => {
    const reg = await request(serverFor(app)).post('/api/auth/register').send({ email: 'a@solv.sg', password: 'password123' }).expect(201);
    const bearer = t => ({ Authorization: `Bearer ${t}` });
    await request(serverFor(app)).get('/api/auth/me').set(bearer(reg.body.token)).expect(200);
    const jwt = require('jsonwebtoken'); const secret = require('../middleware/auth-middleware').jwtSecret();
    expect(jwt.decode(reg.body.token).exp - jwt.decode(reg.body.token).iat).toBe(24 * 3600);
    const img = jwt.sign({ id: reg.body.user.id, userId: reg.body.user.id, receiptId: 'r1', purpose: 'receipt' }, secret);
    await request(serverFor(app)).get('/api/auth/me').set(bearer(img)).expect(401);
    await request(serverFor(app)).post('/api/auth/logout').set(bearer(reg.body.token)).expect(200);
    await request(serverFor(app)).get('/api/auth/me').set(bearer(reg.body.token)).expect(401);
  });

  test('ten wrong passwords hold the account for fifteen minutes, whatever address is asking', async () => {
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'a@solv.sg', password: 'password123' }).expect(201);
    for (let i = 0; i < 10; i++) await request(serverFor(app)).post('/api/auth/login').send({ email: 'a@solv.sg', password: 'wrong-guess' }).expect(401);
    const held = await request(serverFor(app)).post('/api/auth/login').send({ email: 'A@solv.sg', password: 'password123' }).expect(429);
    expect(held.body.error).toMatch(/this account/);
    require('./auth')._failures.clear();
    await request(serverFor(app)).post('/api/auth/login').send({ email: 'a@solv.sg', password: 'password123' }).expect(200);
  });
});
