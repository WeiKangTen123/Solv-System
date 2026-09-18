const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('../fx/providers', () => ({ frankfurter: jest.fn(), erapi: jest.fn() }));

describe('routes/fx', () => {
  let app, users, providers, admin, emp, tokens;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../utils/users'); providers = require('../fx/providers');
    providers.frankfurter.mockReset(); providers.erapi.mockReset();
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/fx', require('./fx'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });

  test('looks up a rate against the company base and 404s an unknown currency', async () => {
    providers.frankfurter.mockResolvedValue({ rate: 0.01341, providerDate: '2026-09-04', source: 'frankfurter' });
    const r = await request(serverFor(app)).get('/api/fx/rate?from=INR&date=2026-09-04').set(as(emp)).expect(200);
    expect(r.body.rate).toMatchObject({ from: 'INR', to: 'SGD', rate: 0.01341, source: 'frankfurter' });
    providers.frankfurter.mockResolvedValue(null); providers.erapi.mockResolvedValue(null);
    await request(serverFor(app)).get('/api/fx/rate?from=ZZZ&date=2026-09-04').set(as(emp)).expect(404);
    await request(serverFor(app)).get('/api/fx/rate?from=rupees').set(as(emp)).expect(400);
  });

  test('only finance and admin may enter a manual rate, which then wins the lookup', async () => {
    providers.frankfurter.mockResolvedValue({ rate: 0.01341, providerDate: '2026-09-04', source: 'frankfurter' });
    await request(serverFor(app)).get('/api/fx/rate?from=INR&date=2026-09-04').set(as(emp)).expect(200);
    await request(serverFor(app)).post('/api/fx/rates').set(as(emp)).send({ from: 'INR', date: '2026-09-04', rate: 0.0135 }).expect(403);
    await request(serverFor(app)).post('/api/fx/rates').set(as(admin)).send({ from: 'INR', date: '2026-09-04', rate: 0.0135 }).expect(201);
    const r = await request(serverFor(app)).get('/api/fx/rate?from=INR&date=2026-09-04').set(as(emp)).expect(200);
    expect(r.body.rate).toMatchObject({ rate: 0.0135, source: 'manual', enteredBy: 'a@solv.sg' });
    const list = await request(serverFor(app)).get('/api/fx/rates').set(as(admin)).expect(200);
    expect(list.body.rates).toHaveLength(2);
    await request(serverFor(app)).delete('/api/fx/rates?from=INR&to=SGD&date=2026-09-04').set(as(admin)).expect(200);
    await request(serverFor(app)).post('/api/fx/rates').set(as(admin)).send({ from: 'INR', date: 'yesterday', rate: 0.0135 }).expect(400);
  });
});
