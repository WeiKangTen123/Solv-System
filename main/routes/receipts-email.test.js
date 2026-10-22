const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');
const { eml, msg, fakePdf, photo, logo } = require('../test-fixtures/mail');

jest.mock('../receipts/receipt-parser', () => ({
  parseReceiptImage: jest.fn().mockResolvedValue(null), parseReceiptText: jest.fn().mockResolvedValue(null), parseReceiptPages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../pdf/render', () => ({ renderPdfPages: jest.fn().mockResolvedValue(null) }));
// The reader's own child process is not what is tested here (intake/email.test.js
// reads a message's PDF the way the reader does).
jest.mock('../pdf/text-extract', () => ({ extractText: jest.fn().mockResolvedValue({ numPages: 1, pages: ['From: Jane Tan <jane@solv.sg> Subject: a receipt typed into a message'] }) }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 1, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'frankfurter', fetchedAt: 'x' }) }));

// Making a photograph and a PDF takes a moment on a busy machine.
const SLOW = 60000;

// An .eml or .msg dropped on a case: POST /api/receipts/email.
describe('routes/receipts — an email dropped on a case', () => {
  let app, users, store, reports, wf, routes, owner, other, ownerTok;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses');
    reports = require('../store/reports'); wf = require('../reports/workflow');
    routes = require('./receipts');
    const boss = await users.createUser({ email: 'boss@solv.sg', password: 'password123' });
    owner = await users.createUser({ email: 'owner@solv.sg', password: 'password123', companyId: boss.companyId });
    other = await users.createUser({ email: 'other@solv.sg', password: 'password123', companyId: boss.companyId });
    ownerTok = jwt.sign({ id: owner.id, email: owner.email, role: owner.role }, require('../middleware/auth-middleware').jwtSecret());
    app = express(); app.use(express.json({ limit: '25mb' })); app.use('/api/receipts', routes);
  });
  afterEach(() => routes._drain());

  const as = t => ({ Authorization: `Bearer ${t}` });
  const newCase = (user = owner) => reports.createReport({ companyId: user.companyId, userId: user.id, kind: 'case', title: 'Chakan job' });
  const drop = (body, tok = ownerTok) => request(serverFor(app)).post('/api/receipts/email').set(as(tok)).send(body);
  const b64 = buf => buf.toString('base64');

  test('its receipt attachments go into the case as receipts from an email, and the rest say why not', async () => {
    const c = newCase();
    const mail = eml({ from: 'Grab <no-reply@grab.com>', subject: 'Your trip receipts', html: '<p>Thanks <img src="cid:logo"></p>', attachments: [
      { filename: 'trip-1.pdf', contentType: 'application/pdf', content: fakePdf(1) },
      { filename: 'trip-2.jpg', contentType: 'image/jpeg', content: await photo() },
      { filename: 'logo.png', contentType: 'image/png', content: await logo(), cid: 'logo' },
      { filename: 'terms.txt', contentType: 'text/plain', content: Buffer.from('terms and conditions') },
    ] });
    const res = await drop({ reportId: c.id, filename: 'receipts.eml', data: b64(mail) }).expect(201);
    expect(res.body).toMatchObject({ subject: 'Your trip receipts', from: 'no-reply@grab.com' });
    expect(res.body.stored.map(s => [s.receipt.originalName, s.receipt.mime, s.receipt.source, s.expense.source, s.expense.reportId])).toEqual([
      ['trip-1.pdf', 'application/pdf', 'upload', 'email', c.id],
      ['trip-2.jpg', 'image/jpeg', 'upload', 'email', c.id],
    ]);
    expect(res.body.stored.every(s => s.imageToken)).toBe(true);
    expect(res.body.skipped).toEqual([
      { name: 'logo.png', why: expect.stringMatching(/^too small/) },
      { name: 'terms.txt', why: 'not a receipt file type' },
    ]);
    await routes._drain();
    expect(reports.getReport(c.id).expenses).toHaveLength(2);
    const states = require('../receipts/read-queue').statesFor(res.body.stored.map(s => s.receipt.id));
    expect([...states.values()].every(s => ['done', 'failed'].includes(s.state))).toBe(true);
  }, SLOW);

  test('a mail with nothing attached is kept as a PDF of the message, named after its subject', async () => {
    const c = newCase();
    const mail = eml({ subject: 'Fwd: Your Grab E-Receipt', html: '<table><tr><td>Total</td><td>S$12.30</td></tr></table>' });
    const res = await drop({ reportId: c.id, data: b64(mail) }).expect(201);
    expect(res.body.stored).toHaveLength(1);
    expect(res.body.stored[0].receipt).toMatchObject({ originalName: 'Your Grab E-Receipt.pdf', mime: 'application/pdf', source: 'upload' });
    expect(res.body.stored[0].expense).toMatchObject({ source: 'email', reportId: c.id, status: 'reading' });
    expect(res.body.skipped).toEqual([]);

    // The same mail again is the same PDF, so it is the duplicate it is.
    const again = await drop({ reportId: c.id, data: b64(mail) }).expect(200);
    expect(again.body.stored).toEqual([]);
    expect(again.body.skipped).toEqual([{ name: 'Your Grab E-Receipt.pdf', why: expect.stringMatching(/already uploaded this receipt/) }]);
  }, SLOW);

  test('an Outlook .msg is read the same way', async () => {
    const c = newCase();
    const mail = msg({ subject: 'Hotel', text: 'Folio attached', attachments: [{ filename: 'folio.pdf', contentType: 'application/pdf', content: fakePdf(9) }] });
    const res = await drop({ reportId: c.id, filename: 'Hotel.msg', data: b64(mail) }).expect(201);
    expect(res.body.stored.map(s => s.receipt.originalName)).toEqual(['folio.pdf']);
    expect(res.body).toMatchObject({ subject: 'Hotel', from: 'jane@solv.sg' });
  }, SLOW);

  test('it needs the owner\'s own case that still takes receipts, and a mail', async () => {
    const data = b64(eml({ attachments: [{ filename: 'r.pdf', contentType: 'application/pdf', content: fakePdf(2) }] }));
    await request(serverFor(app)).post('/api/receipts/email').send({ reportId: newCase().id, data }).expect(401);
    await drop({ data }).expect(400);
    await drop({ reportId: newCase(other).id, data }).expect(403);
    await drop({ reportId: 'no-such-case', data }).expect(404);

    const claimed = newCase();
    const e = store.createExpense({ companyId: owner.companyId, userId: owner.id, status: 'reviewed', currency: 'SGD', total: 10,
      lines: [{ category: 'Other', amount: 10, baseAmount: 10, fxRate: 1, fxSource: 'base', fxRateDate: '2026-09-01' }] });
    reports.addExpense(claimed.id, e.id);
    wf.markClaimed(claimed.id, owner);
    await drop({ reportId: claimed.id, data }).expect(409);

    const c = newCase();
    await drop({ reportId: c.id }).expect(400);
    await drop({ reportId: c.id, data: 'not base64 !!!' }).expect(400);
    const notMail = await drop({ reportId: c.id, filename: 'scan.pdf', data: b64(fakePdf(3)) }).expect(400);
    expect(notMail.body.error).toBe('That file is not an email (.eml or .msg).');
    expect(store.listExpenses({ userId: owner.id }).filter(x => x.receiptId)).toHaveLength(0);
  });

  test('a mail with nothing in it to keep is answered, with the reason, and stores nothing', async () => {
    const c = newCase();
    const res = await drop({ reportId: c.id, data: b64(eml({ subject: 'Empty', text: '' })) }).expect(200);
    expect(res.body.stored).toEqual([]);
    expect(res.body.skipped).toEqual([{ name: 'Empty', why: expect.stringMatching(/no receipt is attached/) }]);
  });
});
