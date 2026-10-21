jest.mock('./receipt-parser', () => ({ parseReceiptImage: jest.fn(), parseReceiptText: jest.fn(), parseReceiptPages: jest.fn(), parseReceiptBatch: jest.fn() }));
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 1, rateDate: '2026-09-01', providerDate: '2026-09-01', source: 'frankfurter', fetchedAt: 'x' }) }));

const MIN = 60 * 1000;

describe('receipts/read-queue', () => {
  let q, store, users, db, a, b, clock, reader;
  let _n = 0;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db = require('../db'); store = require('../store/expenses'); users = require('../store/users');
    q = require('./read-queue');
    a = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    b = await users.createUser({ email: 'b@solv.sg', password: 'password123', companyId: a.companyId });
    clock = Date.parse('2026-10-21T01:00:00.000Z');
    reader = jest.fn(async () => ({ expenseIds: [] }));
    q._configure({ now: () => clock, read: reader, concurrency: 4, perUser: 2 });
  });
  afterEach(() => q.stop());

  // A stored receipt with its one row, still being read, and its job.
  const receipt = (user = a) => {
    const r = store.createReceipt({ companyId: user.companyId, userId: user.id, file: `f${++_n}.jpg`, mime: 'image/jpeg', sha256: `h${_n}` });
    const e = store.createExpense({ companyId: user.companyId, userId: user.id, receiptId: r.id, status: 'reading' });
    return { r, e };
  };
  const queued = (user = a) => {
    const { r, e } = receipt(user);
    // Each job a millisecond younger than the last, so "oldest" means something.
    clock += 1;
    return { r, e, job: q.enqueue({ companyId: user.companyId, userId: user.id, receiptId: r.id, expenseId: e.id }) };
  };
  const stateOf = r => q.statesFor([r.id]).get(r.id);
  // A reader that holds each read until the test lets it go.
  const held = () => {
    const pending = [];
    reader.mockImplementation(job => new Promise(resolve => pending.push({ job, resolve })));
    return pending;
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  // Lets every held read go, and the ones after them through at once.
  const release = pending => {
    reader.mockImplementation(async () => ({ expenseIds: [] }));
    pending.forEach(p => p.resolve({ expenseIds: [] }));
  };

  test('enqueue wakes the worker at once, and a read that lands is done', async () => {
    const { r, job } = queued();
    expect(job).toMatchObject({ state: 'queued', attempts: 0, receiptId: r.id, userId: a.id });
    await q.drain();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0][0]).toMatchObject({ id: job.id, receiptId: r.id, attempts: 1 });
    expect(reader.mock.calls[0][1]).toEqual({ deferIfUnavailable: true });
    expect(stateOf(r)).toEqual({ state: 'done', attempts: 1, nextAt: expect.any(String), errorKind: null, error: null });
  });

  test('a receipt already waiting keeps its job, and statesFor answers for the latest job of each', () => {
    q.stop();
    const { r, e, job } = queued();
    expect(q.enqueue({ companyId: a.companyId, userId: a.id, receiptId: r.id, expenseId: e.id }).id).toBe(job.id);
    const other = queued();
    const states = q.statesFor([r.id, other.r.id, 'nope']);
    expect(states.size).toBe(2);
    expect(states.get(r.id)).toMatchObject({ state: 'queued', attempts: 0 });
  });

  test('fair between people: the oldest job of whoever has the fewest running goes next', async () => {
    q._configure({ concurrency: 2 });
    const pending = held();
    q.stop();
    const mine = [queued(a), queued(a), queued(a)];
    const theirs = [queued(b)];
    q.start();
    // a's three are older, but b's one goes beside a's first rather than behind all three.
    expect(pending.map(p => p.job.receiptId)).toEqual([mine[0].r.id, theirs[0].r.id]);
    // a now has none running and b has one, so a's next is next.
    pending[0].resolve({ expenseIds: [] });
    await settle(); await settle();
    expect(pending.map(p => p.job.receiptId)).toEqual([mine[0].r.id, theirs[0].r.id, mine[1].r.id]);
    release(pending);
    await q.drain();
    expect(reader).toHaveBeenCalledTimes(4);
  });

  test('no more than READ_PER_USER of one person\'s at once, while others still get a turn', async () => {
    const pending = held();
    q.stop();
    for (let i = 0; i < 5; i++) queued(a);
    q.start();
    expect(pending).toHaveLength(2);
    queued(b);
    q._tick();
    expect(pending.map(p => p.job.userId)).toEqual([a.id, a.id, b.id]);
    // As one of a's finishes, the next of a's takes its place, and no more.
    pending[0].resolve({ expenseIds: [] });
    await settle(); await settle();
    expect(pending.map(p => p.job.userId)).toEqual([a.id, a.id, b.id, a.id]);
    release(pending);
    await q.drain();
    expect(reader).toHaveBeenCalledTimes(6);
  });

  test('a busy AI is tried again after 1, 5, 15 and 60 minutes, then released with the reader\'s note', async () => {
    reader.mockResolvedValue({ unavailable: true });
    const done = jest.fn();
    q.setOnDone(done);
    q.stop();
    const { r, e } = queued();
    q.start();
    for (let i = 0; i < q.BUSY_DELAYS_MIN.length; i++) {
      await q.drain();
      const s = stateOf(r);
      expect(s).toMatchObject({ state: 'queued', attempts: i + 1, errorKind: 'unavailable', error: 'The AI service was busy.' });
      expect(Date.parse(s.nextAt) - clock).toBe(q.BUSY_DELAYS_MIN[i] * MIN);
      // still the reader's: the row waits in 'reading' and the receipt is not stamped
      expect(store.getExpense(e.id).status).toBe('reading');
      expect(store.getReceipt(r.id).parsedAt).toBeNull();
      clock += q.BUSY_DELAYS_MIN[i] * MIN - 1000;
      expect(q._tick()).toHaveLength(0);                    // not yet
      clock += 1000;
      await Promise.all(q._tick());
    }
    await q.drain();
    expect(reader).toHaveBeenCalledTimes(5);
    expect(stateOf(r)).toMatchObject({ state: 'failed', attempts: 5, errorKind: 'unavailable' });
    const after = store.getExpense(e.id);
    expect(after.status).toBe('review-needed');
    expect(after.errorMsg).toBe(require('./read-receipt').UNAVAILABLE_NOTE);
    expect(store.getReceipt(r.id).parsedAt).toBeTruthy();
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0]).toMatchObject({ receiptId: r.id, state: 'failed' });
  });

  test('any other failure is tried once more after 30 seconds, then released; only our own sentences are shown', async () => {
    reader.mockRejectedValueOnce(Object.assign(new Error('The receipt file is missing.'), { said: true }))
          .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked at /srv/app.db'));
    const { r, e } = queued();
    await q.drain();
    expect(stateOf(r)).toMatchObject({ state: 'queued', attempts: 1, errorKind: 'error', error: 'The receipt file is missing.' });
    expect(Date.parse(stateOf(r).nextAt) - clock).toBe(q.ERROR_DELAY_MS);
    clock += q.ERROR_DELAY_MS;
    await Promise.all(q._tick());
    expect(stateOf(r)).toMatchObject({ state: 'failed', attempts: 2, errorKind: 'error', error: 'Something went wrong while reading it.' });
    expect(store.getExpense(e.id)).toMatchObject({ status: 'review-needed', errorMsg: q.FAILED_NOTE });
  });

  test('stop: a waiting job is cancelled and its rows handed back with a note; a running one is not stopped half-way', async () => {
    q.stop();
    const { r, e } = queued();
    const job = q.cancel(r.id);
    expect(job.state).toBe('cancelled');
    expect(store.getExpense(e.id)).toMatchObject({ status: 'review-needed', errorMsg: q.STOPPED_NOTE });
    expect(store.getReceipt(r.id).parsedAt).toBeTruthy();
    expect(() => q.cancel(r.id)).toThrow(expect.objectContaining({ status: 409 }));
    q.start();
    await settle();
    expect(reader).not.toHaveBeenCalled();

    const pending = held();
    const running = queued();
    q._tick();
    expect(pending).toHaveLength(1);
    expect(() => q.cancel(running.r.id)).toThrow(/being read now/);
    pending[0].resolve({ expenseIds: [] });
    await q.drain();
    expect(stateOf(running.r).state).toBe('done');
    expect(() => q.cancel('no-such-receipt')).toThrow(expect.objectContaining({ status: 409 }));
  });

  test('try now: a job waiting on its retry is read at once', async () => {
    reader.mockResolvedValueOnce({ unavailable: true });
    const { r } = queued();
    await q.drain();
    expect(stateOf(r)).toMatchObject({ state: 'queued', attempts: 1 });
    q.retryNow(r.id);
    expect(Date.parse(stateOf(r).nextAt)).toBe(clock);
    await q.drain();
    expect(stateOf(r)).toMatchObject({ state: 'done', attempts: 2 });
  });

  test('try now: a failed job starts again from the beginning on rows nobody has touched, and refuses on one somebody has', async () => {
    reader.mockRejectedValue(new Error('boom'));
    const { r, e } = queued();
    await q.drain();
    clock += q.ERROR_DELAY_MS;
    await Promise.all(q._tick());
    expect(stateOf(r).state).toBe('failed');
    expect(store.getExpense(e.id).status).toBe('review-needed');

    reader.mockReset(); reader.mockResolvedValue({ expenseIds: [] });
    q.stop();
    const job = q.retryNow(r.id);
    expect(job).toMatchObject({ state: 'queued', attempts: 0, errorKind: null });
    expect(store.getExpense(e.id)).toMatchObject({ status: 'reading', errorMsg: null });
    expect(store.getReceipt(r.id).parsedAt).toBeNull();
    q.start();
    await q.drain();
    expect(stateOf(r).state).toBe('done');
    expect(() => q.retryNow(r.id)).toThrow(/no longer waiting/);

    reader.mockReset(); reader.mockRejectedValue(new Error('boom'));
    const typed = queued();
    await q.drain();
    clock += q.ERROR_DELAY_MS;
    await Promise.all(q._tick());
    store.updateExpense(typed.e.id, { merchant: 'Typed by hand' });
    expect(() => q.retryNow(typed.r.id)).toThrow(/changed since/);
    expect(() => q.retryNow('no-such-receipt')).toThrow(expect.objectContaining({ status: 409 }));
  });

  test('recover: a job a restart caught mid-read is queued again, without counting the attempt', () => {
    q.stop();
    const { r, job } = queued();
    db.prepare("UPDATE read_jobs SET state = 'reading', attempts = 2, started_at = ? WHERE id = ?").run(new Date(clock).toISOString(), job.id);
    clock += 5 * MIN;
    expect(q.recover()).toBe(1);
    expect(stateOf(r)).toMatchObject({ state: 'queued', attempts: 1, nextAt: new Date(clock).toISOString() });
    expect(q.recover()).toBe(0);
  });

  test('onDone hears of every job that ends, and a slip in it does not stop the queue', async () => {
    const seen = [];
    q.setOnDone(job => { seen.push(job); throw new Error('cover refresh failed'); });
    const one = queued(), two = queued(b);
    await q.drain();
    expect(seen.map(j => [j.receiptId, j.state]).sort()).toEqual([[one.r.id, 'done'], [two.r.id, 'done']].sort());
    expect(seen[0]).toMatchObject({ companyId: a.companyId, attempts: 1, finishedAt: expect.any(String) });
  });

  test('a receipt deleted while it was being read takes its job with it, quietly', async () => {
    const pending = held();
    const done = jest.fn();
    q.setOnDone(done);
    const { r } = queued();
    q._tick();
    store.deleteReceipt(r.id);
    pending[0].resolve({ expenseIds: [] });
    await q.drain();
    expect(q.statesFor([r.id]).size).toBe(0);
    expect(done).not.toHaveBeenCalled();
  });

  // The real reader: the stored file, read through read-receipt.
  test('the stored file is read onto its row; a busy AI leaves the row reading for the next try', async () => {
    q._configure({ read: undefined });
    jest.resetModules();
    require('../db/migrate').run();
    store = require('../store/expenses'); users = require('../store/users');
    const parser = require('./receipt-parser');
    q = require('./read-queue');
    q._configure({ now: () => clock });
    const u = await users.createUser({ email: 'c@solv.sg', password: 'password123' });
    const receiptStore = require('./receipt-store');
    const name = receiptStore.forUser(u.id).save('rq1', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]), 'image/jpeg');
    const r = store.createReceipt({ id: 'rq1', companyId: u.companyId, userId: u.id, file: name, mime: 'image/jpeg', sha256: 'rq1' });
    const e = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, status: 'reading', currency: 'SGD' });

    parser.parseReceiptImage.mockResolvedValueOnce({ receipts: [], split: false, unavailable: true })
      .mockResolvedValueOnce({ split: false, receipts: [{ merchant: 'Grab', date: '2026-09-01', total: 18.4, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [], city: 'Singapore', country: 'SG', docType: 'ride' }] });
    q.enqueue({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id });
    await q.drain();
    expect(store.getExpense(e.id)).toMatchObject({ status: 'reading', errorMsg: null });
    expect(q.statesFor([r.id]).get(r.id)).toMatchObject({ state: 'queued', errorKind: 'unavailable' });
    q.retryNow(r.id);
    await q.drain();
    expect(store.getExpense(e.id)).toMatchObject({ status: 'review-needed', merchant: 'Grab', city: 'Singapore', country: 'SG', docType: 'ride' });
    expect(q.statesFor([r.id]).get(r.id).state).toBe('done');
    q.stop();
  });
});
