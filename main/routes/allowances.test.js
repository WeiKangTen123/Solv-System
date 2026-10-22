const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.01641, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'frankfurter', fetchedAt: '2026-09-18T03:00:00.000Z' }) }));

describe('routes/allowances', () => {
  let app, users, store, reports, policy, admin, emp, other, tokens, trip;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports'); policy = require('../store/policy');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'Admin' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, name: 'Aisha Rahman' });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    // As index.js mounts them: the allowance routes before the case routes.
    app = express(); app.use(express.json());
    app.use('/api/reports', require('./allowances')); app.use('/api/reports', require('./reports')); app.use('/api/expenses', require('./expenses'));
    policy.setPolicy(admin.companyId, { travelDayPct: 75 }, admin.id);
    policy.addRate({ companyId: admin.companyId, country: 'IN', currency: 'INR', dailyAmount: 4000, effectiveFrom: '2026-01-01' });
    trip = reports.createReport({ companyId: admin.companyId, userId: emp.id, kind: 'trip', title: 'India trip', periodFrom: '2026-09-01', periodTo: '2026-09-04' });
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const http = () => request(serverFor(app));
  // A dinner in Pune, read and checked, filed in the trip.
  const dinner = (extra = {}) => store.createExpense({ companyId: admin.companyId, userId: emp.id, reportId: trip.id, status: 'reviewed', merchant: 'Barbeque Nation', category: 'Meals',
    currency: 'INR', total: 1000, receiptDate: '2026-09-02', country: 'IN', receiptId: null,
    lines: [{ category: 'Meals', amount: 1000, baseAmount: 16.41, fxRate: 0.01641, fxRateDate: '2026-09-02', fxSource: 'frankfurter', fxFetchedAt: 'x' }], ...extra });
  const perDiem = (u, body = {}) => http().post(`/api/reports/${trip.id}/per-diem`).set(as(u)).send(body);
  const mileage = (u, body) => http().post(`/api/reports/${trip.id}/mileage`).set(as(u)).send(body);
  const drive = { date: '2026-09-03', from: 'Office', to: 'Changi Airport', km: 12.4, returnTrip: true, purpose: 'Airport run' };

  describe('per diem', () => {
    test('the trip\'s days at the country of its receipts, checked and priced, with an event; the case view comes back', async () => {
      const d = dinner();
      const res = await perDiem(emp).expect(200);
      const row = res.body.report.expenses.find(e => e.source === 'per_diem');
      expect(res.body.expenseId).toBe(row.id);
      expect(row).toMatchObject({ merchant: 'Per diem', category: 'Meals', currency: 'INR', total: 14000, receiptDate: '2026-09-01', status: 'reviewed', country: 'IN', receiptId: null,
        description: 'Per diem, India: 4 days (first and last at 75%) × INR 4,000', baseTotal: 229.74, flags: [] });
      expect(row.lines).toEqual([expect.objectContaining({ category: 'Meals', amount: 14000, currency: 'INR', fxRate: 0.01641, baseAmount: 229.74 })]);
      expect(res.body).toMatchObject({ editable: true, isOwner: true });
      expect(res.body.report.events.at(-1)).toMatchObject({ action: 'edited', note: 'Per diem added: India: 4 days (first and last at 75%) × INR 4,000' });
      // the dinner inside the per diem's days is worth a look; the per diem itself is not
      expect(res.body.report.expenses.find(e => e.id === d.id).flags.map(f => f.code)).toEqual(['per-diem-meal']);
      // the receipts list, which knows only the case's dates, says the same
      const list = await http().get('/api/expenses').set(as(emp)).expect(200);
      expect(list.body.expenses.find(e => e.id === d.id).flags.map(f => f.code)).toEqual(['per-diem-meal']);
      expect(list.body.expenses.find(e => e.id === row.id).flags).toEqual([]);
    });

    test('adding it again replaces it, at the rates and dates as they are now', async () => {
      dinner();
      const first = (await perDiem(emp).expect(200)).body.expenseId;
      reports.updateReport(trip.id, { periodTo: '2026-09-05' });
      const res = await perDiem(emp, { country: 'in' }).expect(200);
      const rows = res.body.report.expenses.filter(e => e.source === 'per_diem');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).not.toBe(first);
      expect(rows[0].total).toBe(18000);
      expect(store.getExpense(first)).toBeNull();
      expect(res.body.report.events.at(-1).note).toBe('Per diem replaced: India: 5 days (first and last at 75%) × INR 4,000');
    });

    test('who may: the owner; an admin who can see the case is refused, anyone else does not see it', async () => {
      await perDiem(admin).expect(403);
      await perDiem(other).expect(404);
      await http().post('/api/reports/nope/per-diem').set(as(emp)).send({}).expect(404);
      await http().post(`/api/reports/${trip.id}/per-diem`).expect(401);
    });

    test('only a Trip with both its days, still open, and a country with a rate', async () => {
      const say = async (status, message, body = {}) => expect((await perDiem(emp, body).expect(status)).body.error).toMatch(message);
      await say(400, /Say which country the per diem is for/);
      await say(400, /no per-diem rate for Sri Lanka/, { country: 'LK' });
      await say(400, /two-letter country code/, { country: 'India' });
      await say(400, /two-letter country code/, { country: 7 });
      reports.updateReport(trip.id, { periodTo: null });
      await say(400, 'Set the trip\'s last day before adding a per diem.', { country: 'IN' });
      reports.updateReport(trip.id, { periodFrom: null });
      await say(400, 'Set the trip\'s first and last day before adding a per diem.', { country: 'IN' });
      reports.updateReport(trip.id, { kind: 'case', periodFrom: '2026-09-01', periodTo: '2026-09-04' });
      await say(400, /A per diem is for a Trip/, { country: 'IN' });
      reports.updateReport(trip.id, { kind: 'trip' });
      dinner();
      await http().post(`/api/reports/${trip.id}/claimed`).set(as(emp)).expect(200);
      await say(409, /claimed case cannot be changed/, { country: 'IN' });
    });

    test('a draft trip takes one too', async () => {
      const draft = reports.createReport({ companyId: admin.companyId, userId: emp.id, draft: true, kind: 'trip', periodFrom: '2026-09-01', periodTo: '2026-09-01' });
      const res = await http().post(`/api/reports/${draft.id}/per-diem`).set(as(emp)).send({ country: 'IN' }).expect(200);
      expect(res.body.report.status).toBe('draft');
      expect(res.body.report.expenses[0]).toMatchObject({ total: 3000, description: 'Per diem, India: 1 day at 75% × INR 4,000' });
    });
  });

  describe('mileage', () => {
    test('refused until the company has a rate', async () => {
      expect((await mileage(emp, drive).expect(400)).body.error).toBe('Your company has no mileage rate yet. An admin sets it in Settings.');
    });

    test('km × the rate in the base currency, there and back, checked, purpose kept', async () => {
      policy.setPolicy(admin.companyId, { mileageRatePerKm: 0.6 }, admin.id);
      const res = await mileage(emp, drive).expect(200);
      const row = res.body.report.expenses.find(e => e.id === res.body.expenseId);
      expect(row).toMatchObject({ source: 'mileage', merchant: 'Mileage', category: 'Fuel/Mileage', currency: 'SGD', total: 14.88, baseTotal: 14.88, receiptDate: '2026-09-03',
        status: 'reviewed', purpose: 'Airport run', receiptId: null, description: 'From Office to Changi Airport and back, 2 × 12.4 km × SGD 0.60', flags: [] });
      expect(row.lines).toEqual([expect.objectContaining({ category: 'Fuel/Mileage', amount: 14.88, fxSource: 'base', baseAmount: 14.88 })]);
      expect(res.body.report.events.at(-1)).toMatchObject({ action: 'edited', note: 'Mileage added: From Office to Changi Airport and back, 2 × 12.4 km × SGD 0.60' });
      const one = await mileage(emp, { date: '2026-09-04', from: ' Hotel ', to: 'Client', km: '3', returnTrip: false }).expect(200);
      expect(one.body.report.expenses.find(e => e.id === one.body.expenseId)).toMatchObject({ total: 1.8, purpose: null, description: 'From Hotel to Client, 3 km × SGD 0.60' });
      policy.setPolicy(admin.companyId, { mileageRatePerKm: 0.585 }, admin.id);
      const odd = await mileage(emp, { ...drive, km: 1234.5, returnTrip: undefined }).expect(200);
      expect(odd.body.report.expenses.find(e => e.id === odd.body.expenseId)).toMatchObject({ total: 722.18, description: 'From Office to Changi Airport, 1,234.5 km × SGD 0.585' });
    });

    test('every field is checked', async () => {
      policy.setPolicy(admin.companyId, { mileageRatePerKm: 0.6 }, admin.id);
      const say = async (body, message) => expect((await mileage(emp, { ...drive, ...body }).expect(400)).body.error).toMatch(message);
      for (const km of [0, -3, 5000.01, 'far', null, '']) await say({ km }, /distance must be a number of km above 0 and at most 5,000/);
      for (const date of ['2026-02-30', '03/09/2026', null, 20260903]) await say({ date }, /day of the drive/);
      await say({ date: '2099-01-01' }, /cannot be in the future/);
      await say({ from: '  ' }, 'Say where the drive started.');
      await say({ to: undefined }, 'Say where the drive ended.');
      await say({ from: ['x'] }, /must be text/);
      await say({ returnTrip: 'yes' }, /return trip: true or false/);
      await say({ purpose: 5 }, /purpose must be text/);
      await mileage(emp, { ...drive, km: 5000 }).expect(200);
      await mileage(admin, drive).expect(403);
      await mileage(other, drive).expect(404);
    });

    test('a drive is flagged like any receipt: outside the trip\'s dates, over the category\'s limit', async () => {
      policy.setPolicy(admin.companyId, { mileageRatePerKm: 0.6, categoryLimits: { 'Fuel/Mileage': 10 } }, admin.id);
      const res = await mileage(emp, { ...drive, date: '2026-08-01' }).expect(200);
      expect(res.body.report.expenses.find(e => e.id === res.body.expenseId).flags.map(f => f.code)).toEqual(['outside-case', 'over-limit']);
      // the owner's dates stay theirs
      expect(res.body.report).toMatchObject({ periodFrom: '2026-09-01', periodTo: '2026-09-04' });
    });
  });

  // Neither row has a receipt file. Imports already make rows like these; a
  // case of nothing else claims, exports and posts all the same.
  test('a case of per diem and mileage alone is claimed, exported as PDF, XLSX and CSV, and dry-run posted to Xero', async () => {
    policy.setPolicy(admin.companyId, { mileageRatePerKm: 0.6 }, admin.id);
    await perDiem(emp, { country: 'IN' }).expect(200);
    await mileage(emp, drive).expect(200);
    const claimed = await http().post(`/api/reports/${trip.id}/claimed`).set(as(emp)).expect(200);
    expect(claimed.body.report).toMatchObject({ status: 'claimed', totals: { totalBase: 244.62, pendingRates: 0, noAmount: 0, unreviewed: 0 } });

    const binary = (res, cb) => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); };
    for (const [format, magic] of [['pdf', '%PDF'], ['xlsx', 'PK'], ['csv', 'Report,Line']]) {
      const u = await http().get(`/api/reports/${trip.id}/export-url?format=${format}`).set(as(emp)).expect(200);
      const out = await http().get(u.body.url).buffer(true).parse(binary).expect(200);
      const text = Buffer.from(out.body).toString(format === 'csv' ? 'utf8' : 'latin1');
      expect(text.startsWith(magic)).toBe(true);
      if (format === 'csv') {
        expect(text).toContain('Per diem,"Per diem, India: 4 days (first and last at 75%) × INR 4,000"');
        expect(text).toContain('Mileage,"From Office to Changi Airport and back, 2 × 12.4 km × SGD 0.60",Airport run');
      }
    }

    const posted = await http().post(`/api/reports/${trip.id}/post?dryRun=1`).set(as(emp)).expect(200);
    expect(posted.body.dryRun).toBe(true);
    expect(posted.body.bill.invoice.lineItems.map(l => l.unitAmount)).toEqual([229.74, 14.88]);
    expect(posted.body.bill.invoice.lineItems[0].description).toMatch(/^1 Sep 2026 · Per diem · Meals · INR 14,000.00 × 0.01641/);
    expect(posted.body.bill.total).toBe(244.62);
    expect(posted.body.bill.attachments).toEqual([]);
  }, 60000);
});
