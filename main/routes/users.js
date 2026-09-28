const express = require('express');
const router  = express.Router();
const users   = require('../store/users');
const { requireAuth } = require('../middleware/auth-middleware');
const { requireRole } = require('../middleware/roles');
const logger  = require('../utils/logger');
const asyncHandler = require('../middleware/async-handler');
const { testGeminiKey } = require('../llm/gemini-client');

// Personal Gemini keys for any signed-in user (user or admin)
router.get('/me/gemini-keys', requireAuth, (req, res) => {
  const list = users.getUserGeminiKeys(req.user.id);
  res.json({
    keys: list.map(k => ({
      id: k.id,
      label: k.label,
      createdAt: k.createdAt,
      keyMasked: k.apiKey.length > 8 ? `${k.apiKey.slice(0, 4)}••••••••••••••••${k.apiKey.slice(-4)}` : '••••',
    }))
  });
});

router.post('/me/gemini-keys', requireAuth, async (req, res) => {
  try {
    const { apiKey, label } = req.body || {};
    const result = users.addUserGeminiKey(req.user.id, apiKey.trim(), label ? label.trim() : null);
    logger.info('User added personal Gemini key', { userId: req.user.id, email: req.user.email });
    res.status(201).json({ success: true, id: result.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/me/gemini-keys/test', requireAuth, async (req, res) => {
  try {
    const { apiKey, keyId } = req.body || {};
    let keyToTest = apiKey;
    if (!keyToTest && keyId) {
      const userKeys = users.getUserGeminiKeys(req.user.id);
      const found = userKeys.find(k => k.id === Number(keyId));
      if (found) keyToTest = found.apiKey;
    }
    if (!keyToTest) return res.status(400).json({ error: 'No API key provided to test' });
    const result = await testGeminiKey(keyToTest);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/me/gemini-keys/:id', requireAuth, (req, res) => {
  const success = users.removeUserGeminiKey(req.user.id, Number(req.params.id));
  if (!success) return res.status(404).json({ error: 'Key not found' });
  logger.info('User removed personal Gemini key', { userId: req.user.id, keyId: req.params.id });
  res.json({ success: true });
});

// Staff directory. Everyone signed in may list names (to pick a colleague for
// "paid on behalf of"); only an admin sees the full rows, creates, changes
// roles or deletes.
router.get('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  const list = users.getAllUsers(me.companyId);
  const full = req.user.role === 'admin';
  res.json({ users: full ? list : list.map(u => ({ id: u.id, name: u.name, email: u.email, department: u.department, role: u.role })) });
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const { email, password, name, role, employeeId, department } = req.body || {};
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const user = await users.createUser({ email, password, name, role: role || 'user', companyId: me.companyId, employeeId, department });
    logger.info('User created', { by: req.user.email, email: user.email, role: user.role });
    res.status(201).json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id', requireAuth, (req, res) => {
  try {
    const target = users.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const me = users.findById(req.user.id);
    if (target.companyId !== me.companyId) return res.status(404).json({ error: 'User not found' });
    const isAdmin = req.user.role === 'admin';
    const self = target.id === req.user.id;
    if (!isAdmin && !self) return res.status(403).json({ error: 'You can only edit your own profile' });
    const body = req.body || {};
    const patch = { name: body.name, employeeId: body.employeeId, department: body.department };
    if (isAdmin) patch.role = body.role;
    const user = users.updateUser(target.id, patch);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Changing a password. Three things this did not do before: check the target
// exists (a mistyped id updated no rows and still answered ok), check the
// target is in the same company, and ask for the current password when you are
// changing your own — which meant a stolen session token was a permanent
// account takeover rather than a seven-day one.
router.post('/:id/password', requireAuth, asyncHandler(async (req, res) => {
  const me = users.findById(req.user.id);
  const target = users.findById(req.params.id);
  if (!target || !me || target.companyId !== me.companyId) return res.status(404).json({ error: 'User not found' });
  const self = target.id === req.user.id;
  if (req.user.role !== 'admin' && !self) return res.status(403).json({ error: 'Not allowed' });
  const { password, currentPassword } = req.body || {};
  if (self) {
    if (!currentPassword) return res.status(400).json({ error: 'Type your current password too' });
    if (!(await users.validatePassword(target.email, currentPassword))) return res.status(403).json({ error: 'That is not your current password' });
  }
  try {
    await users.setPassword(target.id, password);
  } catch (err) { return res.status(400).json({ error: err.message }); }
  logger.info('Password changed', { by: req.user.email, for: target.email, self });
  res.json({ ok: true });
}));

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const me = users.findById(req.user.id);
  const target = users.findById(req.params.id);
  // Company scope, as on PATCH: latent while one company exists, live the day a second one does.
  if (!target || !me || target.companyId !== me.companyId) return res.status(404).json({ error: 'User not found' });
  users.deleteUser(target.id);
  logger.info('User deleted', { by: req.user.email, email: target.email });
  res.json({ ok: true });
});

module.exports = router;
