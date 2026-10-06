const express = require('express');
const router  = express.Router();
const users   = require('../store/users');
const { requireAuth, signSession } = require('../middleware/auth-middleware');
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
      keyMasked: require('../utils/mask').maskKey(k.apiKey),
      lastOkAt: k.lastOkAt, lastErrorAt: k.lastErrorAt, lastError: k.lastError, lastModel: k.lastModel,
    }))
  });
});

router.post('/me/gemini-keys', requireAuth, asyncHandler(async (req, res) => {
  try {
    const { apiKey, label } = req.body || {};
    // Checked here: an absent key used to reach .trim() and come back as
    // "Cannot read properties of undefined".
    if (typeof apiKey !== 'string' || !apiKey.trim()) return res.status(400).json({ error: 'Paste an API key first' });
    const result = users.addUserGeminiKey(req.user.id, apiKey.trim(), typeof label === 'string' && label.trim() ? label.trim() : null);
    logger.info('User added personal Gemini key', { userId: req.user.id });
    res.status(201).json({ success: true, id: result.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Testing a pasted key, before it is saved, makes this server ask Google about
// a key it has never stored. Ten an hour per person is plenty for setting one
// up and too few to check a list of stolen ones.
const RAW_TESTS_PER_HOUR = 10;
const _rawTests = new Map();   // userId -> [timestamps]
function _rawTestAllowed(userId) {
  const now = Date.now();
  const recent = (_rawTests.get(userId) || []).filter(t => now - t < 3600 * 1000);
  if (recent.length >= RAW_TESTS_PER_HOUR) { _rawTests.set(userId, recent); return false; }
  recent.push(now); _rawTests.set(userId, recent);
  return true;
}

router.post('/me/gemini-keys/test', requireAuth, asyncHandler(async (req, res) => {
  const { apiKey, keyId } = req.body || {};
  if (apiKey && !_rawTestAllowed(req.user.id)) return res.status(429).json({ error: 'Too many key tests this hour. Save the key and test it from the list.' });
  // A stored key is tested only when it is the caller's own, and only then is
  // the answer written back onto it.
  const stored = !apiKey && keyId ? users.getUserGeminiKeys(req.user.id).find(k => k.id === Number(keyId)) || null : null;
  const keyToTest = apiKey || (stored && stored.apiKey);
  if (!keyToTest) return res.status(400).json({ error: 'No API key provided to test' });
  try {
    const result = await testGeminiKey(keyToTest);
    if (stored) users.recordKeyUse('user', stored.id, { ok: true, model: result.model });
    res.json({ success: true, ...result });
  } catch (err) {
    if (stored) users.recordKeyUse('user', stored.id, { error: err.message });
    res.status(400).json({ error: err.message });
  }
}));

router.delete('/me/gemini-keys/:id', requireAuth, (req, res) => {
  const success = users.removeUserGeminiKey(req.user.id, Number(req.params.id));
  if (!success) return res.status(404).json({ error: 'Key not found' });
  logger.info('User removed personal Gemini key', { userId: req.user.id, keyId: req.params.id });
  res.json({ success: true });
});

// The staff list is an admin's: a user works on their own claims and has no
// reason to read colleagues' names and emails. It used to be open to every
// account, which with self-registration on meant to anyone on the internet.
router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ users: users.getAllUsers(req.user.companyId) });
});

router.post('/', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  try {
    const { email, password, name, role, employeeId, department } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Email and password are required' });
    const user = await users.createUser({ email, password, name: _text(name, 120), role: role || 'user', companyId: req.user.companyId, employeeId: _text(employeeId, 40), department: _text(department, 80) });
    logger.info('User created', { by: req.user.id, userId: user.id, role: user.role });
    res.status(201).json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// A string field from a body, trimmed and capped, or undefined to leave it.
function _text(v, max) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return typeof v === 'string' ? v.trim().slice(0, max) : undefined;
}

router.patch('/:id', requireAuth, (req, res) => {
  try {
    const target = users.findById(req.params.id);
    if (!target || target.companyId !== req.user.companyId) return res.status(404).json({ error: 'User not found' });
    const isAdmin = req.user.role === 'admin';
    const self = target.id === req.user.id;
    if (!isAdmin && !self) return res.status(404).json({ error: 'User not found' });
    const body = req.body || {};
    const patch = { name: _text(body.name, 120), employeeId: _text(body.employeeId, 40), department: _text(body.department, 80) };
    if (isAdmin && body.role !== undefined && body.role !== target.role) {
      // The company must keep somebody able to run it.
      if (target.role === 'admin' && !target.removed && users.countAdmins(target.companyId) <= 1) {
        return res.status(400).json({ error: 'This is the only admin. Make someone else an admin first.' });
      }
      patch.role = body.role;
    }
    const user = users.updateUser(target.id, patch);
    if (patch.role) logger.info('Role changed', { by: req.user.id, userId: target.id, role: patch.role });
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Changing a password. The target must exist and be in the same company, and
// your own needs the current password, so a stolen session cannot lock you
// out. A new password ends every session signed in with the old one; when it
// is your own, a fresh session comes back so this device stays signed in.
router.post('/:id/password', requireAuth, asyncHandler(async (req, res) => {
  const target = users.findById(req.params.id);
  if (!target || target.companyId !== req.user.companyId) return res.status(404).json({ error: 'User not found' });
  const self = target.id === req.user.id;
  if (req.user.role !== 'admin' && !self) return res.status(404).json({ error: 'User not found' });
  const { password, currentPassword } = req.body || {};
  if (typeof password !== 'string') return res.status(400).json({ error: 'Type the new password' });
  if (self) {
    if (!currentPassword) return res.status(400).json({ error: 'Type your current password too' });
    if (!(await users.validatePassword(target.email, currentPassword))) return res.status(403).json({ error: 'That is not your current password' });
  }
  try {
    await users.setPassword(target.id, password);
  } catch (err) { return res.status(400).json({ error: err.message }); }
  logger.info('Password changed', { by: req.user.id, userId: target.id, self });
  res.json({ ok: true, ...(self ? { token: signSession(target, users.tokenVersion(target.id)) } : {}) });
}));

// Removing a person ends their access and keeps their claims. The admin who
// is asking cannot remove themselves, and the last admin cannot be removed.
router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' });
  const target = users.findById(req.params.id);
  if (!target || target.companyId !== req.user.companyId) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin' && !target.removed && users.countAdmins(target.companyId) <= 1) return res.status(400).json({ error: 'This is the only admin.' });
  users.removeUser(target.id);
  logger.info('User removed', { by: req.user.id, userId: target.id });
  res.json({ ok: true, user: users.findById(target.id) });
});

router.post('/:id/restore', requireAuth, requireRole('admin'), (req, res) => {
  const target = users.findById(req.params.id);
  if (!target || target.companyId !== req.user.companyId) return res.status(404).json({ error: 'User not found' });
  const user = users.restoreUser(target.id);
  logger.info('User restored', { by: req.user.id, userId: target.id });
  res.json({ ok: true, user });
});

module.exports = router;
