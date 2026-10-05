const express = require('express');
const router  = express.Router();
const users   = require('../store/users');
const { requireAuth } = require('../middleware/auth-middleware');
const { requireRole } = require('../middleware/roles');
const asyncHandler = require('../middleware/async-handler');
const { CATEGORY_NAMES } = require('../intake/categories');
const { CURRENCIES } = require('../intake/currencies');
const { GEMINI_MODELS, testGeminiKey } = require('../llm/gemini-client');

// Company settings: name, base currency, exchange-rate policy, the report's
// column set, the LLM API keys. Readable by everyone (the UI needs the
// columns); writable by an admin.
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

// ── LLM API keys ────────────────────────────────────────────────────────────
// Never the key itself: its first and last four characters, and what the
// reader last saw from it.
const masked = k => (k.apiKey.length > 8 ? `${k.apiKey.slice(0, 4)}••••${k.apiKey.slice(-4)}` : '••••');
const view = k => ({ id: k.id, label: k.label, createdAt: k.createdAt, keyMasked: masked(k),
                     lastOkAt: k.lastOkAt, lastErrorAt: k.lastErrorAt, lastError: k.lastError, lastModel: k.lastModel });

router.get('/llm-keys', requireAuth, requireRole('admin'), (req, res) => {
  const me = users.findById(req.user.id);
  res.json({
    keys: users.getGeminiKeys(me.companyId).map(view),
    // Which models read receipts, in the order they are tried, and whether the
    // server has a key of its own to fall back on when none of these works.
    models: GEMINI_MODELS,
    fallbackKey: !!process.env.Gemini_API_KEY,
  });
});

router.post('/llm-keys', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const { apiKey, label } = req.body || {};
    if (typeof apiKey !== 'string' || !apiKey.trim()) return res.status(400).json({ error: 'Paste an API key first' });
    res.status(201).json({ success: true, id: users.addGeminiKey(me.companyId, apiKey, label).id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// One ping to Google with a stored company key, and the answer written back
// onto the key so the list says the same thing the button did.
router.post('/llm-keys/:id/test', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const me = users.findById(req.user.id);
  const key = users.getGeminiKeys(me.companyId).find(k => k.id === Number(req.params.id));
  if (!key) return res.status(404).json({ error: 'Key not found' });
  try {
    const result = await testGeminiKey(key.apiKey);
    users.recordKeyUse('company', key.id, { ok: true, model: result.model });
    res.json({ success: true, ...result });
  } catch (err) {
    users.recordKeyUse('company', key.id, { error: err.message });
    res.status(400).json({ error: err.message });
  }
}));

router.delete('/llm-keys/:id', requireAuth, requireRole('admin'), (req, res) => {
  const me = users.findById(req.user.id);
  if (!users.removeGeminiKey(me.companyId, Number(req.params.id))) return res.status(404).json({ error: 'Key not found' });
  res.json({ success: true });
});

module.exports = router;
