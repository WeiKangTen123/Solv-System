const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

describe('routes/policy', () => {
  let app, users, admin, emp, outsider, tokens;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'Admin' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    // An admin of another company, who must see none of this one's.
    outsider = await users.createUser({ email: 'x@other.sg', password: 'password123', companyId: users.createCompany({ name: 'Other' }).id, role: 'admin' });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, outsider].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/company', require('./policy'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const http = () => request(serverFor(app));

  test('anyone signed in reads the policy, with the currency and the categories it is set in', async () => {
    await http().get('/api/company/policy').expect(401);
    const res = await http().get('/api/company/policy').set(as(emp)).expect(200);
    expect(res.body).toMatchObject({
      policy: { mileageRatePerKm: null, travelDayPct: 100, categoryLimits: {}, maxAgeDays: null, flagWeekends: false },
      baseCurrency: 'SGD', updatedAt: null, updatedBy: null,
    });
    expect(res.body.categories).toEqual(expect.arrayContaining(['Meals', 'Fuel/Mileage']));
  });

  test('only an admin changes it; what was sent is checked and only that changes', async () => {
    await http().put('/api/company/policy').set(as(emp)).send({ maxAgeDays: 30 }).expect(403);
    const res = await http().put('/api/company/policy').set(as(admin)).send({ mileageRatePerKm: 0.6, categoryLimits: { Meals: 50 }, flagWeekends: true }).expect(200);
    expect(res.body.policy).toEqual({ mileageRatePerKm: 0.6, travelDayPct: 100, categoryLimits: { Meals: 50 }, maxAgeDays: null, flagWeekends: true });
    expect(res.body.updatedBy).toEqual({ id: admin.id, name: 'Admin' });
    await http().put('/api/company/policy').set(as(admin)).send({ categoryLimits: { Lodging: 300 } }).expect(200);
    const bad = await http().put('/api/company/policy').set(as(admin)).send({ travelDayPct: 120 }).expect(400);
    expect(bad.body.error).toMatch(/percentage from 0 to 100/);
    expect((await http().put('/api/company/policy').set(as(admin)).send({ weekends: true }).expect(400)).body.error).toMatch(/Unknown policy setting: weekends/);
    expect((await http().put('/api/company/policy').set(as(admin)).send([]).expect(400)).body.error).toMatch(/as an object/);
    // the employee reads what the admin set; the other company does not
    expect((await http().get('/api/company/policy').set(as(emp)).expect(200)).body.policy).toMatchObject({ mileageRatePerKm: 0.6, categoryLimits: { Meals: 50, Lodging: 300 } });
    expect((await http().get('/api/company/policy').set(as(outsider)).expect(200)).body.policy.mileageRatePerKm).toBeNull();
  });

  test('per-diem rates: anyone reads, an admin adds and deletes, each company its own', async () => {
    const body = { country: 'IN', currency: 'INR', dailyAmount: 4000, effectiveFrom: '2026-01-01' };
    await http().post('/api/company/per-diem-rates').set(as(emp)).send(body).expect(403);
    const added = await http().post('/api/company/per-diem-rates').set(as(admin)).send(body).expect(201);
    expect(added.body.rate).toMatchObject({ country: 'IN', countryName: 'India', currency: 'INR', dailyAmount: 4000, effectiveFrom: '2026-01-01', createdBy: admin.id });
    expect(added.body.rates).toHaveLength(1);
    expect((await http().post('/api/company/per-diem-rates').set(as(admin)).send(body).expect(409)).body.error).toMatch(/already a rate for India/);
    expect((await http().post('/api/company/per-diem-rates').set(as(admin)).send({ ...body, country: 'India' }).expect(400)).body.error).toMatch(/two-letter/);
    expect((await http().post('/api/company/per-diem-rates').set(as(admin)).send({ ...body, dailyAmount: 0 }).expect(400)).body.error).toMatch(/above 0/);
    expect((await http().post('/api/company/per-diem-rates').set(as(admin)).send({ ...body, effectiveFrom: 'soon' }).expect(400)).body.error).toMatch(/YYYY-MM-DD/);

    expect((await http().get('/api/company/per-diem-rates').set(as(emp)).expect(200)).body.rates).toHaveLength(1);
    expect((await http().get('/api/company/per-diem-rates').set(as(outsider)).expect(200)).body.rates).toEqual([]);

    const id = added.body.rate.id;
    await http().delete(`/api/company/per-diem-rates/${id}`).set(as(emp)).expect(403);
    await http().delete(`/api/company/per-diem-rates/${id}`).set(as(outsider)).expect(404);
    expect((await http().delete(`/api/company/per-diem-rates/${id}`).set(as(admin)).expect(200)).body).toEqual({ ok: true, rates: [] });
    await http().delete(`/api/company/per-diem-rates/${id}`).set(as(admin)).expect(404);
  });
});
