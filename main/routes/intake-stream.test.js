const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

// GET /api/reports/:id/intake/stream: the case's intake as server-sent
// events, at once and again when the case changes. The queue is stopped, so
// nothing changes but what a test does itself.
describe('GET /api/reports/:id/intake/stream', () => {
  let app, users, store, reports, events, stream, emp, admin, other, tokens;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    require('../receipts/read-queue').stop();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports');
    events = require('../utils/events');
    stream = require('./intake-stream');
    stream._configure({ gatherMs: 20, checkMs: 60_000, keepAliveMs: 60_000, lifeMs: 60_000 });
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'Admin' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, name: 'Aisha' });
    other = await users.createUser({ email: 'o@solv.sg', password: 'password123', companyId: admin.companyId });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, emp, other].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    // Compressed as index.js compresses: a stream that compression held back
    // would never hand these tests their first event.
    app = express(); app.use(require('compression')()); app.use(express.json());
    app.use('/api/reports', stream);
    app.use('/api/reports', require('./reports'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const until = async check => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10)); };

  // Reads the stream as it comes, handing each event to `step(event, all)`
  // until it answers true; then the connection is dropped, as a tab closing
  // drops it. Resolves with the events and the raw text.
  function listen(u, id, step) {
    let raw = '';
    const seen = [];
    return request(serverFor(app)).get(`/api/reports/${id}/intake/stream`).set(as(u))
      .buffer(true)
      .parse((res, done) => {
        let buf = '';
        let over = false;
        const stop = () => { if (over) return; over = true; res.destroy(); done(null, { events: seen, raw }); };
        res.setEncoding('utf8');
        res.on('data', chunk => {
          raw += chunk; buf += chunk;
          let cut;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
            const name = (/^event: (.*)$/m.exec(block) || [])[1];
            const data = (/^data: (.*)$/m.exec(block) || [])[1];
            if (!name) continue;
            seen.push({ name, data: JSON.parse(data) });
            if (!over && step(seen.at(-1), seen)) stop();
          }
        });
        res.on('end', () => { if (!over) { over = true; done(null, { events: seen, raw }); } });
      });
  }

  function receipt(caseId, name) {
    const r = store.createReceipt({ companyId: emp.companyId, userId: emp.id, file: `${name}.jpg`, mime: 'image/jpeg', sizeBytes: 1000, originalName: name });
    store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: r.id, reportId: caseId, status: 'reading' });
    return r;
  }
  const draftOf = async () => (await request(serverFor(app)).post('/api/reports').set(as(emp)).send({ draft: true }).expect(201)).body.report;

  test('sends the intake at once, the same body as GET /intake, with the stream\'s headers', async () => {
    const draft = await draftOf();
    receipt(draft.id, 'a');
    const polled = (await request(serverFor(app)).get(`/api/reports/${draft.id}/intake`).set(as(emp)).expect(200)).body;
    const res = await listen(emp, draft.id, () => true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(res.headers['x-accel-buffering']).toBe('no');
    const [first] = res.body.events;
    expect(first.name).toBe('intake');
    expect(first.data).toEqual(polled);
    expect(first.data.files.map(f => f.originalName)).toEqual(['a']);
  });

  test('a change to the case sends it again; changes close together go as one', async () => {
    const draft = await draftOf();
    receipt(draft.id, 'a');
    const res = await listen(emp, draft.id, (ev, all) => {
      if (all.length === 1) {
        receipt(draft.id, 'b');
        events.caseChanged(draft.id); events.caseChanged(draft.id); events.caseChanged(draft.id);
        return false;
      }
      return true;
    });
    const intakes = res.body.events.filter(e => e.name === 'intake');
    expect(intakes).toHaveLength(2);
    expect(intakes[1].data.files.map(f => f.originalName)).toEqual(['a', 'b']);
  });

  test('a read moving on in the queue reaches the stream of the case it is filed in', async () => {
    const draft = await draftOf();
    const queue = require('../receipts/read-queue');
    const res = await listen(emp, draft.id, (ev, all) => {
      if (all.length === 1) {
        const r = receipt(draft.id, 'scan');
        queue.enqueue({ companyId: emp.companyId, userId: emp.id, receiptId: r.id });
        return false;
      }
      return true;
    });
    const [, second] = res.body.events;
    expect(second.data.files).toHaveLength(1);
    expect(second.data.files[0].read).toMatchObject({ state: 'queued' });
    expect(second.data.counts).toMatchObject({ files: 1, queued: 1 });
  });

  test('an unchanged case sends nothing more; a change made outside the queue is found by the check', async () => {
    stream._configure({ checkMs: 40 });
    const draft = await draftOf();
    receipt(draft.id, 'a');
    let changedAt = 0;
    const res = await listen(emp, draft.id, (ev, all) => {
      if (all.length === 1) {
        // Checks come and go with nothing new: no event. Then a title typed
        // in another tab, which no queue hears of.
        setTimeout(() => { changedAt = Date.now(); reports.updateReport(draft.id, { title: 'Pune visit' }); }, 200);
        return false;
      }
      return true;
    });
    const intakes = res.body.events.filter(e => e.name === 'intake');
    expect(intakes).toHaveLength(2);
    expect(changedAt).toBeGreaterThan(0);
    expect(intakes[1].data.cover.title).toBe('Pune visit');
  });

  test('an event on another case, or one that changes nothing, sends nothing', async () => {
    const draft = await draftOf();
    const elsewhere = await draftOf();
    receipt(draft.id, 'a');
    const res = await listen(emp, draft.id, (ev, all) => {
      if (all.length === 1) {
        events.caseChanged(elsewhere.id);
        events.caseChanged(draft.id);                 // nothing about it changed
        setTimeout(() => { receipt(draft.id, 'c'); events.caseChanged(draft.id); }, 150);
        return false;
      }
      return true;
    });
    const intakes = res.body.events.filter(e => e.name === 'intake');
    expect(intakes).toHaveLength(2);
    expect(intakes[1].data.files.map(f => f.originalName)).toEqual(['a', 'c']);
  });

  test('keep-alive comments while quiet, and a planned end after its time, said as such', async () => {
    stream._configure({ keepAliveMs: 30, lifeMs: 200 });
    const draft = await draftOf();
    const res = await listen(emp, draft.id, () => false);
    expect(res.body.raw).toMatch(/\n: keep-alive\n\n/);
    const names = res.body.events.map(e => e.name);
    expect(names[0]).toBe('intake');
    expect(res.body.events.at(-1)).toEqual({ name: 'end', data: { reason: 'time' } });
    await until(() => events.listenerCount(draft.id) === 0);
    expect(events.listenerCount(draft.id)).toBe(0);
  });

  test('a case deleted while watched ends its stream as gone', async () => {
    const draft = await draftOf();
    const res = await listen(emp, draft.id, (ev, all) => {
      if (all.length === 1) { reports.deleteReport(draft.id); events.caseChanged(draft.id); }
      return false;
    });
    expect(res.body.events.at(-1)).toEqual({ name: 'end', data: { reason: 'gone' } });
  });

  test('a closed tab leaves no listener and no timer behind', async () => {
    const draft = await draftOf();
    await listen(emp, draft.id, () => {
      expect(events.listenerCount(draft.id)).toBe(1);
      return true;
    });
    await until(() => events.listenerCount(draft.id) === 0);
    expect(events.listenerCount(draft.id)).toBe(0);
  });

  test('the owner and an admin may watch; a colleague and a stranger may not', async () => {
    const draft = await draftOf();
    expect((await listen(admin, draft.id, () => true)).body.events[0].data.caseId).toBe(draft.id);
    await request(serverFor(app)).get(`/api/reports/${draft.id}/intake/stream`).set(as(other)).expect(404);
    await request(serverFor(app)).get('/api/reports/no-such-case/intake/stream').set(as(emp)).expect(404);
    await request(serverFor(app)).get(`/api/reports/${draft.id}/intake/stream`).expect(401);
    expect(events.listenerCount(draft.id)).toBe(0);
  });
});

describe('utils/events', () => {
  let events, db, store, users;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    events = require('../utils/events'); db = require('../db'); store = require('../store/expenses'); users = require('../store/users');
  });

  test('a receipt\'s change reaches each case its rows sit in, in one query, and off() stops it', async () => {
    const u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
    const reports = require('../store/reports');
    const one = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'One' });
    const two = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Two' });
    const r = store.createReceipt({ companyId: u.companyId, userId: u.id, file: 'x.jpg', mime: 'image/jpeg' });
    store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, reportId: one.id, status: 'reading' });
    store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, reportId: two.id, status: 'reading' });
    store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, status: 'reading' });
    const heard = [];
    const offOne = events.onCase(one.id, id => heard.push(id));
    const offTwo = events.onCase(two.id, id => heard.push(id));
    expect(events.receiptChanged(r.id).sort()).toEqual([one.id, two.id].sort());
    expect(heard.sort()).toEqual([one.id, two.id].sort());
    offOne(); offOne(); offTwo();
    expect(events.listenerCount(one.id)).toBe(0);
    heard.length = 0;
    // Nobody listening: not even the query.
    const spy = jest.spyOn(db, 'prepare');
    expect(events.receiptChanged(r.id)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
  });

  test('a watcher that throws stops neither the others nor the change', () => {
    const heard = [];
    const off1 = events.onCase('r1', () => { throw new Error('boom'); });
    const off2 = events.onCase('r1', () => heard.push('second'));
    expect(() => events.caseChanged('r1')).not.toThrow();
    expect(heard).toEqual(['second']);
    off1(); off2();
  });

  test('the read queue tells watchers when a job is queued, cancelled and tried again, and a failing watcher never breaks it', async () => {
    const u = await users.createUser({ email: 'q@solv.sg', password: 'password123' });
    const reports = require('../store/reports');
    const c = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Q' });
    const r = store.createReceipt({ companyId: u.companyId, userId: u.id, file: 'x.jpg', mime: 'image/jpeg' });
    store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, reportId: c.id, status: 'reading' });
    const queue = require('../receipts/read-queue');
    queue.stop();
    let heard = 0;
    const off = events.onCase(c.id, () => { heard++; throw new Error('a broken page'); });
    const job = queue.enqueue({ companyId: u.companyId, userId: u.id, receiptId: r.id });
    expect(job.state).toBe('queued');
    expect(heard).toBe(1);
    queue.retryNow(r.id);
    expect(heard).toBe(2);
    queue.cancel(r.id);
    expect(heard).toBe(3);
    off();
  });

  test('a read that starts and lands is heard twice', async () => {
    const u = await users.createUser({ email: 'w@solv.sg', password: 'password123' });
    const reports = require('../store/reports');
    const c = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'W' });
    const r = store.createReceipt({ companyId: u.companyId, userId: u.id, file: 'x.jpg', mime: 'image/jpeg' });
    store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, reportId: c.id, status: 'reading' });
    const queue = require('../receipts/read-queue');
    queue.stop();
    queue._configure({ read: async () => ({ expenseIds: [] }) });
    queue.enqueue({ companyId: u.companyId, userId: u.id, receiptId: r.id });
    const states = [];
    const off = events.onCase(c.id, () => states.push(db.prepare('SELECT state FROM read_jobs WHERE receipt_id = ?').get(r.id).state));
    queue.start();
    await queue.drain(5000);
    queue.stop();
    expect(states).toEqual(['reading', 'done']);
    off();
  });
});
