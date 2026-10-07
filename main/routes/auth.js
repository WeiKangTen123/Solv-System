const express   = require('express');
const router    = express.Router();
const rateLimit = require('express-rate-limit');
const users     = require('../store/users');
const { requireAuth, signSession } = require('../middleware/auth-middleware');
const logger    = require('../utils/logger');
const asyncHandler = require('../middleware/async-handler');
const accountLock = require('../middleware/account-lock');
const { ipBucket } = require('../middleware/rate-limit-key');

// Per address: ten tries in fifteen minutes. An IPv6 address is counted by its
// /64, which one client can move around in freely.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  keyGenerator: req => ipBucket(req.ip), standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts from this address. Try again in 15 minutes.' },
});

// Per account as well (middleware/account-lock.js): the address limit alone
// lets someone guess one person's password from as many addresses as they
// have, and a lock on the email alone let anyone keep its owner out.

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
// One answer for an email that already has an account, removed or not: the
// two used to differ, and told anyone asking which emails had accounts.
router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (!EMAIL_SHAPE.test(email.trim())) return res.status(400).json({ error: 'That is not an email address' });
  if (!registrationOpen()) return res.status(403).json({ error: 'Registration is closed. Ask your administrator to add you.' });
  if (users.findByEmail(email.trim())) return res.status(400).json({ error: 'That email cannot be registered here. If it is yours, sign in, or ask your administrator.' });
  const first = !users.hasUsers();
  let user;
  try {
    user = await users.createUser({ email, password, name: typeof name === 'string' ? name.trim().slice(0, 120) || null : null, companyId: first ? null : users.firstCompanyId() });
  } catch (err) {
    if (err.expose) return res.status(400).json({ error: err.message });
    throw err;
  }
  logger.info('User registered', { userId: user.id, role: user.role });
  res.status(201).json({ success: true, user, token: sign(user) });
}));

router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const key = email.trim().toLowerCase();
    const ip = ipBucket(req.ip);
    if (accountLock.locked(key, ip)) return res.status(429).json({ error: 'Too many wrong passwords for this account. Try again in 15 minutes, or ask your administrator to set a new one.' });
    const user = await users.validatePassword(key, password);
    if (!user) { accountLock.failed(key, ip); return res.status(401).json({ error: 'Invalid email or password' }); }
    accountLock.succeeded(key, ip);
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
  require('../receipts/pairing').revokeForUser(req.user.id);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const user = users.findById(req.user.id);
  const company = users.getCompany(user.companyId);
  const metrics = users.getUserMetrics(req.user.id);
  res.json({ user: { ...user, ...metrics, timezone: company.timezone, baseCurrency: company.baseCurrency, companyName: company.name } });
});

module.exports = router;
