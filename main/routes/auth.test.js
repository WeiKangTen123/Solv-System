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

  test('second registration is refused unless ALLOW_REGISTRATION=true', async () => {
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'a@solv.sg', password: 'password123' }).expect(201);
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'b@solv.sg', password: 'password123' }).expect(403);
    process.env.ALLOW_REGISTRATION = 'true';
    const r = await request(serverFor(app)).post('/api/auth/register').send({ email: 'b@solv.sg', password: 'password123' }).expect(201);
    delete process.env.ALLOW_REGISTRATION;
    expect(r.body.user.role).toBe('employee');
  });

  test('login works with the right password and fails with the wrong one', async () => {
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'a@solv.sg', password: 'password123' }).expect(201);
    await request(serverFor(app)).post('/api/auth/login').send({ email: 'a@solv.sg', password: 'password123' }).expect(200);
    await request(serverFor(app)).post('/api/auth/login').send({ email: 'a@solv.sg', password: 'nope' }).expect(401);
  });
});
