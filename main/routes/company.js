const express = require('express');
const router  = express.Router();
const users   = require('../store/users');
const { requireAuth } = require('../middleware/auth-middleware');
const { requireRole } = require('../middleware/roles');
const { CATEGORY_NAMES } = require('../intake/categories');
const { CURRENCIES } = require('../intake/currencies');

// Company settings: name, base currency, exchange-rate policy, the report's
// column set, reader keys. Readable by everyone (the UI needs the columns);
// writable by admin and finance.
router.get('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  res.json({ company: users.getCompany(me.companyId), categories: CATEGORY_NAMES, currencies: CURRENCIES });
});

router.patch('/', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const b = req.body || {};
    if (b.fxPolicy && !['receipt_date', 'submission_date', 'monthly_fixed'].includes(b.fxPolicy)) return res.status(400).json({ error: 'Unknown exchange-rate policy' });
    if (b.baseCurrency && !/^[A-Z]{3}$/.test(b.baseCurrency)) return res.status(400).json({ error: 'Base currency must be a 3-letter code' });
    const company = users.updateCompany(me.companyId, b);
    res.json({ company });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/llm-keys', requireAuth, requireRole('admin'), (req, res) => {
  const me = users.findById(req.user.id);
  res.json({ keys: users.getGeminiKeys(me.companyId).map(k => ({
    id: k.id, label: k.label, createdAt: k.createdAt,
    keyMasked: k.apiKey.length > 8 ? `${k.apiKey.slice(0, 4)}••••${k.apiKey.slice(-4)}` : '••••',
  })) });
});

router.post('/llm-keys', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const { apiKey, label } = req.body || {};
    res.status(201).json({ success: true, id: users.addGeminiKey(me.companyId, apiKey, label).id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/llm-keys/:id', requireAuth, requireRole('admin'), (req, res) => {
  const me = users.findById(req.user.id);
  if (!users.removeGeminiKey(me.companyId, Number(req.params.id))) return res.status(404).json({ error: 'Key not found' });
  res.json({ success: true });
});

module.exports = router;
