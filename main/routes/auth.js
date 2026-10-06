const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');
const users     = require('../store/users');
const { requireAuth, signSession } = require('../middleware/auth-middleware');
const logger    = require('../utils/logger');
const asyncHandler = require('../middleware/async-handler');

// Per address: ten tries in fifteen minutes.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  keyGenerator: req => req.ip, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts from this address. Try again in 15 minutes.' },
});

// Per account as well: the address limit alone lets someone guess one
// person's password from as many addresses as they have. Ten wrong answers for
// one email in fifteen minutes holds that email for fifteen minutes, whoever
// is asking. In memory, like the address limit.
const LOCK_AFTER = 10, LOCK_WINDOW_MS = 15 * 60 * 1000;
const _failures = new Map();   // email -> { count, first, lockedUntil }
function _locked(email) {
  const f = _failures.get(email);
  if (!f) return false;
  if (f.lockedUntil && f.lockedUntil > Date.now()) return true;
  if (Date.now() - f.first > LOCK_WINDOW_MS) _failures.delete(email);
  return false;
}
function _failed(email) {
  const now = Date.now();
  const f = _failures.get(email);
  const cur = f && now - f.first <= LOCK_WINDOW_MS ? f : { count: 0, first: now, lockedUntil: 0 };
  cur.count++;
  if (cur.count >= LOCK_AFTER) cur.lockedUntil = now + LOCK_WINDOW_MS;
  _failures.set(email, cur);
}

const sign = user => signSession(user, users.tokenVersion(user.id));

// Whether anyone may create their own account: always for the very first
// account, which creates the company; after that only when an admin has
// switched it on in Company settings. It used to be the ALLOW_REGISTRATION
// environment variable, which was left on in production and needed a server
// login to turn off. The variable is no longer read.
function registrationOpen() {
  if (!users.hasUsers()) return true;
  const company = users.getCompany(users.firstCompanyId());
  return !!(company && company.allowRegistration);
}

router.get('/status', (_req, res) => res.json({ hasUsers: users.hasUsers(), registrationOpen: registrationOpen() }));

// The first account creates the company and is its admin. After that,
// registration is closed unless an admin opens it; admins add staff.
router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (!registrationOpen()) return res.status(403).json({ error: 'Registration is closed. Ask your administrator to add you.' });
    const first = !users.hasUsers();
    const user = await users.createUser({ email, password, name: typeof name === 'string' ? name.slice(0, 120) : null, companyId: first ? null : users.firstCompanyId() });
    logger.info('User registered', { userId: user.id, role: user.role });
    res.status(201).json({ success: true, user, token: sign(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const key = email.trim().toLowerCase();
    if (_locked(key)) return res.status(429).json({ error: 'Too many wrong passwords for this account. Try again in 15 minutes.' });
    const user = await users.validatePassword(key, password);
    if (!user) { _failed(key); return res.status(401).json({ error: 'Invalid email or password' }); }
    _failures.delete(key);
    logger.info('User logged in', { userId: user.id, role: user.role });
    res.json({ token: sign(user), user });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
}));

// Signing out ends every session this person has, on every device: the token
// in the browser is not the only copy, and a stolen one must die with it.
router.post('/logout', requireAuth, (req, res) => {
  users.endSessions(req.user.id);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const user = users.findById(req.user.id);
  const company = users.getCompany(user.companyId);
  const metrics = users.getUserMetrics(req.user.id);
  res.json({ user: { ...user, ...metrics, timezone: company.timezone, baseCurrency: company.baseCurrency, companyName: company.name } });
});

module.exports = router;
module.exports._failures = _failures;
