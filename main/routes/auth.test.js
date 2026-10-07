const request = require('supertest');
const express = require('express');
const { serverFor } = require('../scripts/test-server');

describe('routes/auth', () => {
  let app;
  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    app = express();
    app.set('trust proxy', true);     // so a test can sign in "from" different addresses
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

  // Ten wrong passwords for an account hold the address that sent them. The
  // lock used to be on the account alone, so one address could keep everyone
  // out of it — the only admin included — for as long as it kept trying.
  test('ten wrong passwords hold the guessing address out of that account, not its owner elsewhere', async () => {
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'a@solv.sg', password: 'password123' }).expect(201);
    const login = (from, password, email = 'a@solv.sg') => request(serverFor(app)).post('/api/auth/login').set('X-Forwarded-For', from).send({ email, password });
    for (let i = 0; i < 10; i++) await login('203.0.113.7', 'wrong-guess').expect(401);
    const held = await login('203.0.113.7', 'password123', 'A@solv.sg').expect(429);
    expect(held.body.error).toMatch(/this account/);
    await login('198.51.100.20', 'password123').expect(200);
  });

  // Spread over many addresses, the guess locks the account for addresses
  // that have never signed in to it; the owner's usual place still gets in.
  test('a guess spread over many addresses locks the account, except where its owner has signed in before', async () => {
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'a@solv.sg', password: 'password123' }).expect(201);
    const login = (from, password) => request(serverFor(app)).post('/api/auth/login').set('X-Forwarded-For', from).send({ email: 'a@solv.sg', password });
    await login('198.51.100.20', 'password123').expect(200);                   // the owner's office
    const { SPREAD_AFTER, LOCK_AFTER } = require('../middleware/account-lock');
    for (let i = 0; i < SPREAD_AFTER; i++) await login(`203.0.113.${Math.floor(i / (LOCK_AFTER - 1))}`, 'wrong-guess');
    await login('192.0.2.99', 'password123').expect(429);                      // a new place
    await login('198.51.100.20', 'password123').expect(200);                   // the office
  });

  test('an IPv6 client is counted by its /64', () => {
    const { ipBucket } = require('../middleware/rate-limit-key');
    expect(ipBucket('2001:db8:abcd:12::1')).toBe(ipBucket('2001:db8:abcd:12:ffff:1:2:3'));
    expect(ipBucket('2001:db8:abcd:12::1')).not.toBe(ipBucket('2001:db8:abcd:13::1'));
    expect(ipBucket('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
  });

  test('registration checks the email, and does not say whether an account exists', async () => {
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'not-an-email', password: 'password123' }).expect(400);
    await request(serverFor(app)).post('/api/auth/register').send({ email: ' First@Solv.sg ', password: 'password123' }).expect(201);
    require('../store/users').updateCompany(require('../store/users').firstCompanyId(), { allowRegistration: true });
    const again = await request(serverFor(app)).post('/api/auth/register').send({ email: 'first@solv.sg', password: 'password123' }).expect(400);
    expect(again.body.error).not.toMatch(/exists|removed/i);
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'b@solv.sg', password: '        ' }).expect(400);
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'c@solv.sg', password: 'x'.repeat(80) }).expect(400);
  });
});
