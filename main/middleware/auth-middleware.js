const jwt = require('jsonwebtoken');

// The signing secret. Required everywhere but the test suite: it used to fall
// back to a string printed in this public repository whenever NODE_ENV was
// anything but exactly "production" — "prod", or unset — and with it anybody
// could sign a login, an image link or an export link. index.js asks for it at
// boot so a box without one refuses to start rather than starting open.
const TEST_SECRET = 'test-secret-not-for-use-outside-jest';
function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'test') return TEST_SECRET;
  throw new Error('FATAL SECURITY ERROR: JWT_SECRET must be set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
}

// A session lasts a day, and ends early on sign-out, a password change or
// removal: each bumps the person's token_version, and a token issued under an
// older number is refused.
const SESSION_TTL = '24h';
function signSession(user, version) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role, tv: version ?? 0, typ: 'session' }, jwtSecret(), { expiresIn: SESSION_TTL });
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  let claims;
  if (req._session && req._session.token === token) claims = req._session.claims;
  else {
    try {
      claims = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }
  // Receipt-image and export links are signed with the same secret. They carry
  // a purpose and no id; only a session may sign anybody in.
  if (!claims || !claims.id || claims.purpose) return res.status(401).json({ error: 'Invalid or expired token' });
  // The token says who; the database says whether they still exist, whether
  // they were removed, and what they may do. Role is read from here, never
  // from the token, so a demotion takes effect on the next request.
  //
  // users.js is required lazily to avoid a require-cycle at module load
  // (users.js doesn't need this module, but plenty of routes require both).
  const users = require('../store/users');
  const live  = users.findSession(claims.id);
  if (!live) return res.status(401).json({ error: 'Account no longer exists' });
  if (live.removed) return res.status(401).json({ error: 'This account has been removed. Ask your administrator.' });
  if ((claims.tv ?? 0) !== live.tokenVersion) return res.status(401).json({ error: 'Your session has ended. Sign in again.' });
  req.user = { id: live.id, email: live.email, role: live.role, companyId: live.companyId };
  // Throttled to at most one DB write per user per minute — see
  // users.js#touchLastSeen. Failure here must never turn into a 401 — it's
  // presence tracking, not auth.
  try { users.touchLastSeen(req.user.id); } catch {}
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, jwtSecret, signSession, SESSION_TTL };
