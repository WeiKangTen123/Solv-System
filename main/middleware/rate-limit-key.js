const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./auth-middleware');

// Which requests share one rate-limit bucket.
//
// One bucket per signed-in user, so a shared office IP does not throttle
// everyone at once. A phone-capture link carries no login; a LIVE link's token
// is its identity, so each phone gets its own bucket rather than draining the
// desktop users beside it. Everything else falls back to the IP.
//
// Only a live link earns its own bucket. Any path under /capture/ used to, so
// changing one character of the URL was a fresh, full allowance — the global
// limit bypassed, and a new entry in the limiter's memory for every attempt.
function rateLimitKey(req) {
  const capture = /^\/api\/receipts\/capture\/([^/]+)/.exec(req.path || '');
  if (capture && require('../receipts/pairing').verify(capture[1])) return `capture:${capture[1]}`;

  const auth = (req.headers && req.headers.authorization) || '';
  if (auth.startsWith('Bearer ')) {
    try {
      const claims = jwt.verify(auth.slice(7), jwtSecret(), { algorithms: ['HS256'] });
      // Kept on the request, so requireAuth does not verify the same token again.
      req._session = { token: auth.slice(7), claims };
      if (claims && claims.id && !claims.purpose) return `user:${claims.id}`;
    } catch { /* not ours; use the IP */ }
  }
  return `ip:${req.ip}`;
}

module.exports = { rateLimitKey };
