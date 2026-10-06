// Which bucket a request is counted in. A live phone link gets its own; a
// made-up one is counted against the address, as is anything not signed in.
describe('middleware/rate-limit-key', () => {
  let rateLimitKey, pairing, jwt, secret;
  beforeEach(() => {
    jest.resetModules();
    ({ rateLimitKey } = require('./rate-limit-key'));
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
});
