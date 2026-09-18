const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('axios');
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => ({})) }));

describe('routes/xero', () => {
  let app, users, admin, emp, tokens, axios;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    axios = require('axios'); axios.post.mockReset(); axios.get.mockReset();
    users = require('../store/users');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    process.env.XERO_OAUTH_REDIRECT_URI = 'https://solv.example/api/xero/oauth/callback';
    app = express(); app.use(express.json()); app.use('/api/xero', require('./xero'));
  });
  afterEach(() => { delete process.env.XERO_OAUTH_REDIRECT_URI; });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });

  test('credentials: finance/admin only, secrets stored encrypted, reported as set, never returned', async () => {
    await request(serverFor(app)).patch('/api/xero/credentials').set(as(emp)).send({ XERO_CLIENT_ID: 'x' }).expect(403);
    await request(serverFor(app)).patch('/api/xero/credentials').set(as(admin)).send({ XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'shh', DEFAULT_ACCOUNT_CODE: '429' }).expect(200);
    const s = await request(serverFor(app)).get('/api/xero').set(as(admin)).expect(200);
    expect(s.body.fields.XERO_CLIENT_ID).toEqual({ value: 'cid', isSet: true });
    expect(s.body.fields.XERO_CLIENT_SECRET).toEqual({ value: '', isSet: true });
    expect(JSON.stringify(s.body)).not.toContain('shh');
    const raw = require('../db').prepare('SELECT xero_client_secret FROM company_credentials').get().xero_client_secret;
    expect(raw).not.toContain('shh');
    await request(serverFor(app)).patch('/api/xero/credentials').set(as(admin)).send({ XERO_CLIENT_SECRET: '' }).expect(200);   // blank keeps it
    expect(users.getCompanyConfig(admin.companyId).XERO_CLIENT_SECRET).toBe('shh');
  });

  test('Custom Connection test connects and persists the orgs', async () => {
    users.saveCompanyConfig(admin.companyId, { XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'shh' });
    axios.post.mockResolvedValue({ data: { access_token: 'tok', expires_in: 1800 } });
    axios.get.mockResolvedValue({ data: [{ tenantId: 't1', tenantName: 'Solv Pte Ltd' }] });
    const r = await request(serverFor(app)).post('/api/xero/test').set(as(admin)).expect(200);
    expect(r.body.tenants).toEqual([{ tenantId: 't1', tenantName: 'Solv Pte Ltd' }]);
    const t = await request(serverFor(app)).get('/api/xero/tenants').set(as(emp)).expect(200);
    expect(t.body).toMatchObject({ connectionType: 'custom', tenants: [expect.objectContaining({ tenantId: 't1' })] });
  });

  test('OAuth: the consent URL carries the company app id; completion needs the state of the same person', async () => {
    await request(serverFor(app)).get('/api/xero/oauth/connect').set(as(admin)).expect(400);   // no web app yet
    users.saveCompanyConfig(admin.companyId, { XERO_OAUTH_CLIENT_ID: 'web-id', XERO_OAUTH_CLIENT_SECRET: 'web-secret' });
    const c = await request(serverFor(app)).get('/api/xero/oauth/connect').set(as(admin)).expect(200);
    const url = new URL(c.body.url);
    expect(url.searchParams.get('client_id')).toBe('web-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://solv.example/api/xero/oauth/callback');
    const state = url.searchParams.get('state');
    const cb = await request(serverFor(app)).get(`/api/xero/oauth/callback?code=abc&state=${state}`).expect(302);
    expect(cb.headers.location).toContain('xero_oauth=pending');
    await request(serverFor(app)).post('/api/xero/oauth/complete').set(as(admin)).send({ code: 'abc', state: 'not-mine' }).expect(400);
    axios.post.mockResolvedValue({ data: { access_token: 'tok', refresh_token: 'rt', expires_in: 1800 } });
    axios.get.mockResolvedValue({ data: [{ tenantId: 't1', tenantName: 'Solv Pte Ltd' }] });
    await request(serverFor(app)).post('/api/xero/oauth/complete').set(as(admin)).send({ code: 'abc', state }).expect(200);
    expect(users.getCompanyConfig(admin.companyId).XERO_CONNECTION_TYPE).toBe('oauth');
    await request(serverFor(app)).delete('/api/xero/oauth/disconnect').set(as(admin)).expect(200);
    expect((await request(serverFor(app)).get('/api/xero/tenants').set(as(admin))).body.tenants).toEqual([]);
  });

  test('accounts need a connection', async () => {
    await request(serverFor(app)).get('/api/xero/accounts').set(as(admin)).expect(400);
  });
});
