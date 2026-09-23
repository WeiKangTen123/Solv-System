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
    const e = await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'e@solv.sg', password: 'password123', name: 'Elaine', department: 'Sales' }).expect(201);
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
});
