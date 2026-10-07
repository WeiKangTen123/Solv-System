const jwt = require('jsonwebtoken');

// The signing secret. Required everywhere but the test suite: it used to fall
// back to a string printed in this public repository whenever NODE_ENV was
// anything but exactly "production" — "prod", or unset — and with it anybody
// could sign a login, an image link or an export link. index.js asks for it at
// boot so a box without one refuses to start rather than starting open.
//
// Nor is the value from .env.example accepted, which is in the same public
// repository: preflight refused it, but only for a box started through
// deploy.sh. A production secret must also be long enough not to be guessed.
const TEST_SECRET = 'test-secret-not-for-use-outside-jest';
const EXAMPLE_SECRET = 'change-me-to-a-long-random-string';
const GENERATE = 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';
function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) {
    if (secret === EXAMPLE_SECRET) throw new Error(`FATAL SECURITY ERROR: JWT_SECRET is still the example value from .env.example. ${GENERATE}`);
    if (process.env.NODE_ENV === 'production' && secret.length < 32) throw new Error(`FATAL SECURITY ERROR: JWT_SECRET is ${secret.length} characters; use at least 32. ${GENERATE}`);
    return secret;
  }
  if (process.env.NODE_ENV === 'test') return TEST_SECRET;
  throw new Error(`FATAL SECURITY ERROR: JWT_SECRET must be set. ${GENERATE}`);
}

// The session token from "Authorization: Bearer <token>", read one way for
// requireAuth and the rate limiter alike: they used to read it differently,
// so the claims the limiter kept could be for a token requireAuth never saw.
function bearerToken(req) {
  const m = /^Bearer\s+(\S+)\s*$/.exec((req.headers && req.headers.authorization) || '');
  return m ? m[1] : null;
}

// A session lasts a day, and ends early on sign-out, a password change or
// removal: each bumps the person's token_version, and a token issued under an
// older number is refused.
const SESSION_TTL = '24h';
function signSession(user, version) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role, tv: version ?? 0, typ: 'session' }, jwtSecret(), { expiresIn: SESSION_TTL });
}

function requireAuth(req, res, next) {
  const token = bearerToken(req);
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

module.exports = { requireAuth, jwtSecret, bearerToken, signSession, SESSION_TTL };
