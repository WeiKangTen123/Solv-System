const express = require('express');
const router  = express.Router();
const users   = require('../store/users');
const { requireAuth } = require('../middleware/auth-middleware');
const { requireRole } = require('../middleware/roles');
const logger  = require('../utils/logger');

// Staff directory. Everyone signed in may list names (to pick a colleague for
// "paid on behalf of"); only admins create, change roles or delete.
router.get('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  const list = users.getAllUsers(me.companyId);
  const full = req.user.role === 'admin' || req.user.role === 'finance';
  res.json({ users: full ? list : list.map(u => ({ id: u.id, name: u.name, email: u.email, department: u.department, role: u.role })) });
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const { email, password, name, role, employeeId, department, managerId } = req.body || {};
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const user = await users.createUser({ email, password, name, role: role || 'employee', companyId: me.companyId, employeeId, department, managerId: managerId || null });
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
    if (isAdmin) { patch.role = body.role; patch.managerId = body.managerId; }
    const user = users.updateUser(target.id, patch);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/password', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.params.id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
    await users.setPassword(req.params.id, (req.body || {}).password);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const target = users.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  users.deleteUser(target.id);
  logger.info('User deleted', { by: req.user.email, email: target.email });
  res.json({ ok: true });
});

module.exports = router;
