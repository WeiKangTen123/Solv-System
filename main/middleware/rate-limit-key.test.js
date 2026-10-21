// Which bucket a request is counted in. A live phone link gets its own; a
// made-up one is counted against the address, as is anything not signed in.
describe('middleware/rate-limit-key', () => {
  let rateLimitKey, skipRateLimit, pairing, jwt, secret;
  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    // A phone link belongs to a person, and phone_pairings says so.
    const db = require('../db'), at = new Date().toISOString();
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('c1', 'Solv', ?)").run(at);
    db.prepare("INSERT INTO users (id, company_id, email, password, created_at) VALUES ('u1', 'c1', 'u1@solv.sg', 'x', ?)").run(at);
    ({ rateLimitKey, skipRateLimit } = require('./rate-limit-key'));
    pairing = require('../receipts/pairing'); pairing._reset();
    jwt = require('jsonwebtoken'); secret = require('./auth-middleware').jwtSecret();
  });
  const req = (path, auth) => ({ path, ip: '1.2.3.4', headers: auth ? { authorization: `Bearer ${auth}` } : {} });

  test('only a live capture link earns its own bucket', () => {
    const live = pairing.create('u1');
    expect(rateLimitKey(req(`/api/receipts/capture/${live}`))).toBe(`capture:${live}`);
    expect(rateLimitKey(req('/api/receipts/capture/made-up-token-1'))).toBe('ip:1.2.3.4');
    expect(rateLimitKey(req('/api/receipts/capture/made-up-token-2'))).toBe('ip:1.2.3.4');
  });

  test('a session is counted per user; an image or export link, and junk, per address', () => {
    expect(rateLimitKey(req('/api/expenses', jwt.sign({ id: 'u1' }, secret)))).toBe('user:u1');
    expect(rateLimitKey(req('/api/expenses', jwt.sign({ userId: 'u1', purpose: 'receipt' }, secret)))).toBe('ip:1.2.3.4');
    expect(rateLimitKey(req('/api/expenses', 'not-a-token'))).toBe('ip:1.2.3.4');
  });

  // The New case page polls this every two seconds while a batch is read.
  test('only the read of a case\'s intake goes uncounted', () => {
    const get = path => ({ method: 'GET', path });
    expect(skipRateLimit(get('/api/reports/1760000000000abcdefgh/intake'))).toBe(true);
    expect(skipRateLimit(get('/api/reports/r1/intake/'))).toBe(true);
    expect(skipRateLimit({ method: 'POST', path: '/api/reports/r1/intake' })).toBe(false);
    for (const path of ['/api/reports/r1', '/api/reports/intake', '/api/reports/r1/intake/x', '/api/reports/r1/intakes',
      '/api/receipts/r1/intake', '/api/reports/r1/export-url', '/x/api/reports/r1/intake', '/api/reports/a/b/intake']) {
      expect(skipRateLimit(get(path))).toBe(false);
    }
  });
});
