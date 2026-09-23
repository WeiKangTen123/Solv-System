const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { requireRole } = require('../middleware/roles');
const users = require('../store/users');
const rates = require('../fx/rates');

// Exchange rates: a lookup for the screen, the cache for finance to read,
// and manual rates finance types in (a monthly table, or a correction).

// GET /api/fx/rate?from=INR&date=2026-09-04   (to = the company base unless given)
router.get('/rate', requireAuth, async (req, res) => {
  const me = users.findById(req.user.id);
  const to = String(req.query.to || users.getCompany(me.companyId).baseCurrency).toUpperCase();
  const from = String(req.query.from || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(from)) return res.status(400).json({ error: 'from must be a 3-letter currency code' });
  const r = await rates.getRate({ from, to, date: req.query.date || undefined });
  if (!r) return res.status(404).json({ error: `No rate for ${from} to ${to}` });
  res.json({ rate: r });
});

router.get('/rates', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  res.json({ rates: rates.listRates({ to: req.query.to || users.getCompany(me.companyId).baseCurrency, from: req.query.from || undefined, since: req.query.since || undefined }) });
});

router.post('/rates', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const { from, to, date, rate } = req.body || {};
    res.status(201).json({ rate: rates.setManualRate({ from, to: to || users.getCompany(me.companyId).baseCurrency, date, rate, by: req.user.email }) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/rates', requireAuth, requireRole('admin'), (req, res) => {
  const { from, to, date } = req.query;
  if (!rates.deleteManualRate({ from: String(from || '').toUpperCase(), to: String(to || '').toUpperCase(), date })) return res.status(404).json({ error: 'No manual rate on that day' });
  res.json({ ok: true });
});

module.exports = router;
