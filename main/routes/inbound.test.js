const request = require('supertest');
const express = require('express');
const { serverFor } = require('../scripts/test-server');
const { eml, fakePdf } = require('../test-fixtures/mail');

jest.mock('../receipts/receipt-parser', () => ({
  parseReceiptImage: jest.fn().mockResolvedValue(null), parseReceiptText: jest.fn().mockResolvedValue(null), parseReceiptPages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../pdf/render', () => ({ renderPdfPages: jest.fn().mockResolvedValue(null) }));
jest.mock('../pdf/text-extract', () => ({ extractText: jest.fn().mockResolvedValue({ numPages: 1, pages: ['From: Jane Tan <jane@solv.sg> Subject: a receipt typed into a message'] }) }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 1, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'frankfurter', fetchedAt: 'x' }) }));

const SECRET = 'a-long-random-secret-for-the-tests';
const DOMAIN = 'in.solv.sg';

// Mail forwarded to a person's address, posted by the mail provider:
// POST /api/inbound/email.
describe('routes/inbound', () => {
  let app, users, store, reports, wf, receipts, jane, other, address, token;

  beforeEach(async () => {
    jest.resetModules();
    process.env.INBOUND_EMAIL_DOMAIN = DOMAIN;
    process.env.INBOUND_EMAIL_SECRET = SECRET;
    require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses');
    reports = require('../store/reports'); wf = require('../reports/workflow');
    receipts = require('./receipts');
    const boss = await users.createUser({ email: 'boss@solv.sg', password: 'password123' });
    jane = await users.createUser({ email: 'jane@solv.sg', password: 'password123', companyId: boss.companyId });
    other = await users.createUser({ email: 'other@solv.sg', password: 'password123', companyId: boss.companyId });
    address = users.inboundAddress(jane.id);
    token = /^receipts\+([a-z0-9]+)@/.exec(address)[1];
    app = express();
    app.use(express.json({ limit: '100kb' }));          // as index.js has it in front of every route
    app.use('/api/inbound', require('./inbound'));
  });
  afterEach(async () => {
    delete process.env.INBOUND_EMAIL_DOMAIN;
    delete process.env.INBOUND_EMAIL_SECRET;
    await receipts._drain();
  });

  // As the Cloudflare Email Worker in docs/RUNBOOK.md sends it.
  const post = (mail, { to = address, auth = `Bearer ${SECRET}`, headers = {} } = {}) => {
    let r = request(serverFor(app)).post(`/api/inbound/email${to ? `?to=${encodeURIComponent(to)}` : ''}`).set('Content-Type', 'message/rfc822');
    if (auth) r = r.set('Authorization', auth);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(mail);
  };
  const withPdf = (extra = {}) => eml({ from: 'Jane Tan <jane@solv.sg>', to: address, subject: 'Taxi', text: 'receipt attached',
    attachments: [{ filename: 'taxi.pdf', contentType: 'application/pdf', content: fakePdf(Math.random()) }], ...extra });
  const janes = () => store.listExpenses({ userId: jane.id }).filter(e => e.receiptId);

  test('it is off until both the domain and the secret are set', async () => {
    delete process.env.INBOUND_EMAIL_SECRET;
    await post(withPdf()).expect(404);
    process.env.INBOUND_EMAIL_SECRET = SECRET;
    delete process.env.INBOUND_EMAIL_DOMAIN;
    await post(withPdf()).expect(404);
    expect(janes()).toHaveLength(0);
  });

  test('only the provider, holding the secret, may post', async () => {
    await post(withPdf(), { auth: null }).expect(401);
    await post(withPdf(), { auth: 'Bearer not-the-secret' }).expect(401);
    await post(withPdf(), { auth: `Basic ${SECRET}` }).expect(401);
    await post(withPdf(), { auth: `Bearer ${SECRET}x` }).expect(401);
    expect(janes()).toHaveLength(0);
    await post(withPdf()).expect(202);
  });

  test('a mail from the person, to their address, is taken: its receipts land outside any case, from an email', async () => {
    const res = await post(withPdf()).expect(202);
    expect(res.body).toEqual({ stored: 1, skipped: [], reportId: null });
    const [e] = janes();
    expect(e).toMatchObject({ source: 'email', reportId: null });
    expect(store.getReceipt(e.receiptId)).toMatchObject({ originalName: 'taxi.pdf', source: 'upload', mime: 'application/pdf' });
    expect(users.inboundMailsLastDay(jane.id)).toBe(1);
  });

  test('with nothing attached, the message itself is kept as a PDF; what is not a receipt says why', async () => {
    const mail = eml({ from: 'jane@solv.sg', to: address, subject: 'Fwd: Your Grab E-Receipt', html: '<p>Total S$12.30</p>',
      attachments: [{ filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('hello') }] });
    const res = await post(mail).expect(202);
    expect(res.body).toEqual({ stored: 1, skipped: [{ name: 'notes.txt', why: 'not a receipt file type' }], reportId: null });
    expect(store.getReceipt(janes()[0].receiptId)).toMatchObject({ originalName: 'Your Grab E-Receipt.pdf', mime: 'application/pdf' });
  });

  test('the recipient is the one the provider names, else X-Original-To, else the To of the mail itself, in any case', async () => {
    await post(withPdf(), { to: `"Jane" <${address.toUpperCase()}>` }).expect(202);
    await post(withPdf(), { to: null, headers: { 'X-Original-To': address } }).expect(202);
    await post(withPdf({ to: `Receipts <${address}>, someone@else.com` }), { to: null }).expect(202);
    expect(janes()).toHaveLength(3);
  });

  test('an address that is nobody\'s, or a removed person\'s, takes nothing', async () => {
    const nobody = [
      `receipts+zzzzzzzzzzzz@${DOMAIN}`,             // no such token
      `receipts+${token}@elsewhere.sg`,              // another domain
      `invoices+${token}@${DOMAIN}`,                 // not the receipts address
      `receipts@${DOMAIN}`,                          // no token at all
    ];
    for (const to of nobody) await post(withPdf(), { to }).expect(404);
    await post(withPdf({ to: 'someone@else.com' }), { to: null }).expect(404);
    users.removeUser(jane.id);
    await post(withPdf()).expect(404);
    expect(janes()).toHaveLength(0);
  });

  // The address is not a secret, so it is not what lets a mail in.
  test('a mail from any other address is dropped with a 202, stores nothing and is not counted', async () => {
    const res = await post(withPdf({ from: 'Grab <no-reply@grab.com>' })).expect(202);
    expect(res.body).toEqual({ dropped: 'sender' });
    await post(withPdf({ from: 'other@solv.sg' })).expect(202);
    expect(janes()).toHaveLength(0);
    expect(store.listExpenses({ userId: other.id })).toHaveLength(0);
    expect(users.inboundMailsLastDay(jane.id)).toBe(0);
    // the person's own address, however it is capitalised, is theirs
    await post(withPdf({ from: 'JANE@Solv.SG' })).expect(202);
    expect(janes()).toHaveLength(1);
  });

  test('a subject naming one of the person\'s open cases files the receipts there, and nobody else\'s case', async () => {
    const mine = reports.createReport({ companyId: jane.companyId, userId: jane.id, kind: 'case', title: 'Chakan job' });
    const theirs = reports.createReport({ companyId: other.companyId, userId: other.id, kind: 'case', title: 'Theirs' });
    const claimed = reports.createReport({ companyId: jane.companyId, userId: jane.id, kind: 'case', title: 'Done' });
    const e = store.createExpense({ companyId: jane.companyId, userId: jane.id, status: 'reviewed', currency: 'SGD', total: 10,
      lines: [{ category: 'Other', amount: 10, baseAmount: 10, fxRate: 1, fxSource: 'base', fxRateDate: '2026-09-01' }] });
    reports.addExpense(claimed.id, e.id);
    wf.markClaimed(claimed.id, jane);
    expect(mine.number).toMatch(/^EXP-\d{4}-\d{4}$/);

    const filed = await post(withPdf({ subject: `Fwd: taxi for ${mine.number.toLowerCase()}` })).expect(202);
    expect(filed.body.reportId).toBe(mine.id);
    expect(reports.getReport(mine.id).expenses).toHaveLength(1);

    for (const subject of [`Taxi ${theirs.number}`, `Taxi ${claimed.number}`, 'Taxi EXP-2099-9999']) {
      const res = await post(withPdf({ subject })).expect(202);
      expect(res.body).toMatchObject({ stored: 1, reportId: null });
    }
    expect(reports.getReport(theirs.id).expenses).toHaveLength(0);
    expect(reports.getReport(claimed.id).expenses).toHaveLength(1);

    // the first number that is one of theirs and open wins
    const second = await post(withPdf({ subject: `${theirs.number} and ${mine.number}` })).expect(202);
    expect(second.body.reportId).toBe(mine.id);
  });

  test('a hundred mails in a day, then no more until the day has rolled on', async () => {
    const db = require('../db');
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    for (let i = 0; i < 5; i++) db.prepare('INSERT INTO inbound_mails (user_id, received_at) VALUES (?, ?)').run(jane.id, old);
    for (let i = 0; i < 99; i++) users.recordInboundMail(jane.id);
    expect(users.inboundMailsLastDay(jane.id)).toBe(99);       // yesterday's do not count
    await post(withPdf()).expect(202);
    // answered before the body is read when the provider names the recipient,
    // and after it when only the mail does
    const refused = await post(withPdf()).expect(429);
    expect(refused.body.error).toMatch(/100 emails in the last day/);
    await post(withPdf(), { to: null }).expect(429);
    expect(janes()).toHaveLength(1);
    // and the rows from before yesterday are gone
    expect(db.prepare('SELECT COUNT(*) AS n FROM inbound_mails WHERE received_at < ?').get(new Date(Date.now() - 24 * 3600 * 1000).toISOString()).n).toBe(5);
  });

  test('what is not a mail is refused', async () => {
    const empty = await request(serverFor(app)).post(`/api/inbound/email?to=${encodeURIComponent(address)}`).set('Authorization', `Bearer ${SECRET}`).expect(400);
    expect(empty.body.error).toMatch(/empty/);
    const pdf = await post(fakePdf(5)).expect(400);
    expect(pdf.body.error).toBe('That file is not an email (.eml or .msg).');
    expect(janes()).toHaveLength(0);
  });

  // A provider may label the raw message anything, or nothing at all.
  test('the message is read whatever it is labelled', async () => {
    await request(serverFor(app)).post(`/api/inbound/email?to=${encodeURIComponent(address)}`).set('Authorization', `Bearer ${SECRET}`)
      .set('Content-Type', 'application/octet-stream').send(withPdf()).expect(202);
    await request(serverFor(app)).post(`/api/inbound/email?to=${encodeURIComponent(address)}`).set('Authorization', `Bearer ${SECRET}`)
      .set('Content-Type', 'text/plain').send(withPdf().toString('utf8')).expect(202);
    expect(janes()).toHaveLength(2);
  });
});
