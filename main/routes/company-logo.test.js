const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

// The company logo for the case PDF: an admin's to set, kept as a small PNG on
// white, and given back with the company.
describe('routes/company — logo', () => {
  let app, users, sharp, admin, emp, tokens;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); sharp = require('sharp');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'Admin' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    // As index.js mounts it: no body parser in front of the logo's own.
    app = express(); app.use('/api/company', require('./company'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const http = () => request(serverFor(app));
  const dataUri = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

  test('an admin sets it; it is kept as a PNG on white no wider than 900 pixels, and comes back with the company', async () => {
    const clear = await sharp({ create: { width: 1600, height: 400, channels: 4, background: { r: 15, g: 110, b: 86, alpha: 0.5 } } }).png().toBuffer();
    await http().post('/api/company/logo').set(as(emp)).send({ dataUri: dataUri(clear) }).expect(403);
    const res = await http().post('/api/company/logo').set(as(admin)).send({ dataUri: dataUri(clear) }).expect(200);
    expect(res.body.company.logo).toMatch(/^data:image\/png;base64,/);
    const kept = Buffer.from(res.body.company.logo.split(',')[1], 'base64');
    const meta = await sharp(kept).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 900, height: 225, hasAlpha: false });
    expect(users.getCompany(admin.companyId).logo).toBe(res.body.company.logo);
  });

  test('a JPEG is taken too; anything that is not a picture, or is over 2 MB, is refused and nothing changes', async () => {
    const jpg = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#0F6E56' } }).jpeg().toBuffer();
    await http().post('/api/company/logo').set(as(admin)).send({ dataUri: dataUri(jpg, 'image/jpeg') }).expect(200);
    const before = users.getCompany(admin.companyId).logo;
    expect((await http().post('/api/company/logo').set(as(admin)).send({ dataUri: 'data:image/svg+xml;base64,PHN2Zz4=' }).expect(400)).body.error).toMatch(/PNG, JPEG or WebP/);
    expect((await http().post('/api/company/logo').set(as(admin)).send({ dataUri: dataUri(Buffer.from('not a picture at all')) }).expect(400)).body.error).toMatch(/could not be read/);
    const big = require('crypto').randomBytes(2.1 * 1024 * 1024);
    expect((await http().post('/api/company/logo').set(as(admin)).send({ dataUri: dataUri(big) }).expect(413)).body.error).toMatch(/over 2 MB/);
    expect(users.getCompany(admin.companyId).logo).toBe(before);
  });

  test('an admin removes it', async () => {
    const png = await sharp({ create: { width: 200, height: 60, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await http().post('/api/company/logo').set(as(admin)).send({ dataUri: dataUri(png) }).expect(200);
    await http().delete('/api/company/logo').set(as(emp)).expect(403);
    const res = await http().delete('/api/company/logo').set(as(admin)).expect(200);
    expect(res.body.company.logo).toBeNull();
    expect(users.getCompany(admin.companyId).logo).toBeNull();
  });
});
