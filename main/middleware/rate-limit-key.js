const jwt = require('jsonwebtoken');
const { jwtSecret, bearerToken } = require('./auth-middleware');

// The address a limit is counted against. An IPv6 client is given a whole /64
// by its provider and can use any address in it, so counting per address gave
// it eighteen quintillion fresh allowances; it is counted per /64 instead.
function ipBucket(ip) {
  const raw = String(ip || '');
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (v4) return v4[1];
  if (!raw.includes(':')) return raw;
  const [head, tail = ''] = raw.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = raw.includes('::') && tail ? tail.split(':') : [];
  const groups = raw.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

// Which requests share one rate-limit bucket.
//
// One bucket per signed-in user, so a shared office IP does not throttle
// everyone at once. A phone-capture link carries no login; a LIVE link's token
// is its identity, so each phone gets its own bucket rather than draining the
// desktop users beside it. Everything else falls back to the address.
//
// Only a live link earns its own bucket. Any path under /capture/ used to, so
// changing one character of the URL was a fresh, full allowance — the global
// limit bypassed, and a new entry in the limiter's memory for every attempt.
function rateLimitKey(req) {
  const capture = /^\/api\/receipts\/capture\/([^/]+)/.exec(req.path || '');
  if (capture && require('../receipts/pairing').verify(capture[1])) return `capture:${capture[1]}`;

  // The same reading of the header requireAuth makes, so the claims kept
  // here are always for the token it would have verified.
  const token = bearerToken(req);
  if (token) {
    try {
      const claims = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
      // Kept on the request, so requireAuth does not verify the same token again.
      req._session = { token, claims };
      if (claims && claims.id && !claims.purpose) return `user:${claims.id}`;
    } catch { /* not ours; use the address */ }
  }
  return `ip:${ipBucket(req.ip)}`;
}

module.exports = { rateLimitKey, ipBucket };
