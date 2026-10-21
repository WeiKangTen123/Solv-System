require('../db/migrate').run();
const db = require('../db');
const pairing = require('./pairing');

// Pairings belong to people, and the table says so: the user ids the tests
// below use are real rows.
{
  const at = new Date().toISOString();
  db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('c-pair', 'Solv', ?)").run(at);
  for (const id of ['u1', 'u2', 'alice', 'bob', '12345']) {
    db.prepare("INSERT INTO users (id, company_id, email, password, created_at) VALUES (?, 'c-pair', ?, 'x', ?)").run(id, `${id}@solv.sg`, at);
  }
}

// A pairing token is a bearer credential that travels in a URL and is displayed
// on screen as a QR code. Everything below exists to pin the properties that
// make that acceptable: it expires, it is bounded, it is scoped to one user,
// and it grants nothing but upload.
describe('receipts/pairing', () => {
  beforeEach(() => { pairing._reset(); jest.useRealTimers(); });
  afterAll(() => { pairing._reset(); });

  describe('create', () => {
    test('mints a distinct, high-entropy token each time', () => {
      const a = pairing.create('u1'), b = pairing.create('u1');
      expect(a).not.toBe(b);
      // 32 random bytes in base64url.
      expect(a.length).toBeGreaterThanOrEqual(42);
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test('a fresh token verifies and reports its budget', () => {
      const t = pairing.create('u1');
      const v = pairing.verify(t);
      expect(v.userId).toBe('u1');
      expect(v.usesLeft).toBe(pairing.MAX_USES);
      expect(v.expiresInMs).toBeGreaterThan(0);
      expect(v.expiresInMs).toBeLessThanOrEqual(pairing.TTL_MS);
    });

    test('a numeric user id is normalised, so lookups match either way', () => {
      const t = pairing.create(12345);
      expect(pairing.verify(t).userId).toBe('12345');
      expect(pairing.ownedBy(t, 12345)).toBe(true);
      expect(pairing.ownedBy(t, '12345')).toBe(true);
    });
  });

  describe('verify', () => {
    test('rejects unknown, empty and non-string tokens', () => {
      expect(pairing.verify('nope')).toBeNull();
      expect(pairing.verify('')).toBeNull();
      expect(pairing.verify(null)).toBeNull();
      expect(pairing.verify(undefined)).toBeNull();
      expect(pairing.verify({})).toBeNull();
    });

    test('does NOT consume — the phone checks before opening a camera', () => {
      const t = pairing.create('u1');
      pairing.verify(t); pairing.verify(t); pairing.verify(t);
      expect(pairing.verify(t).usesLeft).toBe(pairing.MAX_USES);
    });

    test('an expired token is rejected and forgotten', () => {
      jest.useFakeTimers();
      const t = pairing.create('u1');
      jest.advanceTimersByTime(pairing.TTL_MS + 1);
      expect(pairing.verify(t)).toBeNull();
      expect(pairing.activeCount()).toBe(0);
    });

    test('a token still alive just inside the window works', () => {
      jest.useFakeTimers();
      const t = pairing.create('u1');
      jest.advanceTimersByTime(pairing.TTL_MS - 1000);
      expect(pairing.verify(t)).not.toBeNull();
    });
  });

  describe('consume', () => {
    test('counts uploads down from the cap', () => {
      const t = pairing.create('u1');
      expect(pairing.consume(t)).toMatchObject({ uses: 1, usesLeft: pairing.MAX_USES - 1 });
      expect(pairing.verify(t).usesLeft).toBe(pairing.MAX_USES - 1);
    });

    test('records which receipts arrived, so the desktop can show the photos', () => {
      const t = pairing.create('u1');
      pairing.consume(t, 'r1');
      pairing.consume(t, 'r2');
      expect(pairing.status(t).receiptIds).toEqual(['r1', 'r2']);
      expect(pairing.verify(t).receiptIds).toEqual(['r1', 'r2']);
    });

    test('multiple uploads are allowed — a stack of receipts needs one scan', () => {
      // Single-use would force a rescan per receipt, which is the difference
      // between a feature people use and one they avoid.
      const t = pairing.create('u1');
      for (let i = 0; i < 5; i++) expect(pairing.consume(t)).not.toBeNull();
      expect(pairing.verify(t)).not.toBeNull();
    });

    test('the token stops AUTHORISING once the cap is reached', () => {
      const t = pairing.create('u1');
      for (let i = 0; i < pairing.MAX_USES; i++) pairing.consume(t, `r${i}`);
      // verify() gates uploads, so it must refuse. This is the check that stops
      // a spent pairing from accepting one photo more than it allows.
      expect(pairing.verify(t)).toBeNull();
    });

    test('a spent token can still be DESCRIBED, so the desktop renders what arrived', () => {
      const t = pairing.create('u1');
      for (let i = 0; i < pairing.MAX_USES; i++) pairing.consume(t, `r${i}`);
      const st = pairing.status(t);
      expect(st.alive).toBe(false);
      expect(st.spent).toBe(true);
      expect(st.receiptIds).toHaveLength(pairing.MAX_USES);
    });

    test('status and verify disagree by design on a spent token', () => {
      // Conflating them once allowed uploads past the cap.
      const t = pairing.create('u1');
      for (let i = 0; i < pairing.MAX_USES; i++) pairing.consume(t);
      expect(pairing.verify(t)).toBeNull();      // authorisation: refused
      expect(pairing.status(t)).not.toBeNull();  // description: still available
    });

    test('consuming an unknown token is null, not a throw', () => {
      expect(pairing.consume('nope')).toBeNull();
    });
  });

  describe('revoke and ownership', () => {
    test('revoking kills the token immediately', () => {
      const t = pairing.create('u1');
      expect(pairing.revoke(t)).toBe(true);
      expect(pairing.verify(t)).toBeNull();
      expect(pairing.revoke(t)).toBe(false);
    });

    test('a token belongs to exactly one user', () => {
      const t = pairing.create('u1');
      expect(pairing.ownedBy(t, 'u1')).toBe(true);
      expect(pairing.ownedBy(t, 'u2')).toBe(false);
      expect(pairing.ownedBy('nope', 'u1')).toBe(false);
    });

    test('one user\'s token never resolves to another user', () => {
      const a = pairing.create('alice'), b = pairing.create('bob');
      expect(pairing.verify(a).userId).toBe('alice');
      expect(pairing.verify(b).userId).toBe('bob');
    });
  });

  describe('housekeeping', () => {
    test('expired entries are swept rather than accumulating', () => {
      jest.useFakeTimers();
      pairing.create('u1'); pairing.create('u2');
      expect(pairing.activeCount()).toBe(2);
      jest.advanceTimersByTime(pairing.TTL_MS + 1);
      expect(pairing.activeCount()).toBe(0);
    });
  });
});

// ── Sliding expiry ──────────────────────────────────────────────────────────
describe('receipts/pairing — the link follows the work', () => {
  beforeEach(() => { pairing._reset(); jest.useRealTimers(); });
  afterAll(() => { pairing._reset(); jest.useRealTimers(); });

  test('each upload pushes expiry back out, so a long stack is not cut off', () => {
    jest.useFakeTimers();
    const t = pairing.create('u1');

    // A minute before it would die — then a photo arrives.
    jest.advanceTimersByTime(pairing.TTL_MS - 60_000);
    expect(pairing.verify(t)).not.toBeNull();
    pairing.consume(t, 'r1');

    // As long again: without the extension this would be long gone.
    jest.advanceTimersByTime(pairing.TTL_MS - 60_000);
    expect(pairing.verify(t)).not.toBeNull();
    expect(pairing.status(t).expiresInMs).toBeGreaterThan(0);
  });

  test('an abandoned code still dies on time — nothing extends it', () => {
    // This is the case the short TTL exists for, and it must not regress.
    jest.useFakeTimers();
    const t = pairing.create('u1');
    jest.advanceTimersByTime(pairing.TTL_MS + 1);
    expect(pairing.verify(t)).toBeNull();
  });

  test('extending cannot outlive the upload cap', () => {
    jest.useFakeTimers();
    const t = pairing.create('u1');
    for (let i = 0; i < pairing.MAX_USES; i++) {
      jest.advanceTimersByTime(60_000);
      pairing.consume(t, `r${i}`);
    }
    // Still inside the extended window, but the budget is spent.
    expect(pairing.verify(t)).toBeNull();
  });

  test('revoking beats any amount of extending', () => {
    const t = pairing.create('u1');
    pairing.consume(t, 'r1');
    pairing.revoke(t);
    expect(pairing.verify(t)).toBeNull();
    expect(pairing.status(t)).toBeNull();
  });
});

// ── Kept in the database ────────────────────────────────────────────────────
describe('receipts/pairing — in phone_pairings', () => {
  beforeEach(() => { pairing._reset(); jest.useRealTimers(); });
  afterAll(() => { pairing._reset(); jest.useRealTimers(); });

  test('half an hour, fifty photos, at most three live codes a person', () => {
    expect(pairing.TTL_MS).toBe(30 * 60 * 1000);
    expect(pairing.MAX_USES).toBe(50);
    expect(pairing.MAX_LIVE_PER_USER).toBe(3);
  });

  test('a fourth code retires the person\'s oldest, and nobody else\'s', () => {
    const theirs = pairing.create('u2');
    const [first, ...rest] = [1, 2, 3, 4].map(() => pairing.create('u1'));
    expect(pairing.verify(first)).toBeNull();
    for (const t of rest) expect(pairing.verify(t)).not.toBeNull();
    expect(pairing.verify(theirs)).not.toBeNull();
    expect(pairing.activeCount()).toBe(4);
  });

  test('only a hash of the token is stored', () => {
    const t = pairing.create('u1', { reportId: null });
    const rows = db.prepare('SELECT * FROM phone_pairings').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(require('crypto').createHash('sha256').update(t).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(t);
  });

  test('a link survives a restart, with its uses and its photos', () => {
    const t = pairing.create('u1');
    pairing.consume(t, 'r1');
    // A new process: the module's memory is gone, the database is not.
    jest.isolateModules(() => {
      jest.doMock('../db', () => db);
      const fresh = require('./pairing');
      expect(fresh.verify(t)).toMatchObject({ userId: 'u1', usesLeft: pairing.MAX_USES - 1, receiptIds: ['r1'] });
      expect(fresh.ownedBy(t, 'u1')).toBe(true);
    });
    jest.dontMock('../db');
  });

  test('signing out ends every link the person has', () => {
    const a = pairing.create('u1'), b = pairing.create('u1'), c = pairing.create('u2');
    expect(pairing.revokeForUser('u1')).toBe(2);
    expect(pairing.verify(a)).toBeNull();
    expect(pairing.verify(b)).toBeNull();
    expect(pairing.verify(c)).not.toBeNull();
  });
});
