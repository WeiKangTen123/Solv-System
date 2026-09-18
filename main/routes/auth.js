const express   = require('express');
const router    = express.Router();
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const users     = require('../store/users');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
const logger    = require('../utils/logger');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  keyGenerator: req => req.ip, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts from this address. Try again in 15 minutes.' },
});

function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret(), { expiresIn: '7d' });
}

router.get('/status', (_req, res) => res.json({ hasUsers: users.hasUsers() }));

// The first account creates the company and is its admin. After that,
// registration is closed unless ALLOW_REGISTRATION=true; admins add staff.
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (users.hasUsers() && process.env.ALLOW_REGISTRATION !== 'true') {
      return res.status(403).json({ error: 'Registration is closed. Ask your administrator to add you.' });
    }
    // A later self-registration (flag on) joins the first company as an employee.
    const first = !users.hasUsers();
    const companyId = first ? null : users.readUsers()[0].companyId;
    const user = await users.createUser({ email, password, name: name || null, companyId });
    logger.info('User registered', { email: user.email, role: user.role });
    res.status(201).json({ success: true, user, token: sign(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await users.validatePassword(email, password);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    logger.info('User logged in', { email: user.email, role: user.role });
    res.json({ token: sign(user), user });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', requireAuth, (_req, res) => res.json({ ok: true }));

router.get('/me', requireAuth, (req, res) => {
  const user = users.findById(req.user.id);
  const company = users.getCompany(user.companyId);
  res.json({ user: { ...user, timezone: company.timezone, baseCurrency: company.baseCurrency, companyName: company.name } });
});

module.exports = router;
