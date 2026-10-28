const express = require('express');
const router  = express.Router();
const users   = require('../store/users');
const { requireAuth } = require('../middleware/auth-middleware');
const { requireRole } = require('../middleware/roles');
const asyncHandler = require('../middleware/async-handler');
const { CATEGORY_NAMES } = require('../intake/categories');
const { CURRENCIES, CURRENCY_CODES } = require('../intake/currencies');
const { companyHasPriced } = require('../store/expenses');
const logger = require('../utils/logger');

// A zone name as the date library spells it ("asia/singapore" is accepted by
// Intl but stored that way broke the SGT label on the PDF and the browser's
// own formatting), or null when it is not a real zone.
const ZONES = new Set([...(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []), 'UTC']);
function canonicalZone(tz) {
  try {
    const name = new Intl.DateTimeFormat('en', { timeZone: String(tz) }).resolvedOptions().timeZone;
    return ZONES.size > 1 && !ZONES.has(name) ? null : name;
  } catch { return null; }
}
const { GEMINI_MODELS, testGeminiKey } = require('../llm/gemini-client');

// Company settings: name, base currency, exchange-rate policy, the report's
// column set, the LLM API keys. Readable by everyone (the UI needs the
// columns); writable by an admin.
router.get('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  // baseCurrencyLocked lets the settings page say why the field cannot change,
  // instead of the whole save failing with a 409.
  res.json({ company: { ...users.getCompany(me.companyId), baseCurrencyLocked: companyHasPriced(me.companyId) }, categories: CATEGORY_NAMES, currencies: CURRENCIES });
});

// Only the fields an admin edits here, each checked: the whole body used to
// be handed to the store.
router.patch('/', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ error: 'The company needs a name' });
      patch.name = b.name.trim().slice(0, 120);
    }
    if (b.fxPolicy !== undefined) {
      if (!['receipt_date', 'submission_date', 'monthly_fixed'].includes(b.fxPolicy)) return res.status(400).json({ error: 'Unknown exchange-rate policy' });
      patch.fxPolicy = b.fxPolicy;
    }
    if (b.baseCurrency !== undefined) {
      if (typeof b.baseCurrency !== 'string' || !CURRENCY_CODES.includes(b.baseCurrency)) return res.status(400).json({ error: 'Base currency must be one of the listed currency codes' });
      // Every converted amount is stored as a number in the base currency of
      // the day it was priced. Changing the base afterwards relabelled them all:
      // SGD 100 became "USD 100" on screen, in exports and on Xero bills.
      const current = users.getCompany(req.user.companyId);
      if (b.baseCurrency !== current.baseCurrency) {
        if (companyHasPriced(req.user.companyId)) return res.status(409).json({ error: `The base currency cannot change once receipts have been converted to ${current.baseCurrency}: every amount already converted is in ${current.baseCurrency}. It can be set before the first receipt.` });
      }
      patch.baseCurrency = b.baseCurrency;
    }
    if (b.timezone !== undefined) {
      const zone = canonicalZone(b.timezone);
      if (!zone) return res.status(400).json({ error: 'Unknown time zone. Use a name such as Asia/Singapore.' });
      patch.timezone = zone;
    }
    // Columns are categories, matched without regard to case and listed once.
    // "meals" used to move every Meals line into Other, and "Meals" twice
    // printed two Meals columns, each meal reading as counted twice.
    if (b.reportColumns !== undefined) {
      if (!Array.isArray(b.reportColumns) || b.reportColumns.some(c => typeof c !== 'string')) return res.status(400).json({ error: 'Report columns must be a list of names' });
      const byLower = new Map(CATEGORY_NAMES.map(n => [n.toLowerCase(), n]));
      const columns = [...new Set(b.reportColumns.map(c => byLower.get(c.trim().toLowerCase())))];
      const unknown = b.reportColumns.filter(c => !byLower.has(c.trim().toLowerCase()));
      if (unknown.length) return res.status(400).json({ error: `Not a category: ${unknown.slice(0, 3).join(', ')}. Columns are chosen from the category list.` });
      if (!columns.length) return res.status(400).json({ error: 'Choose at least one report column' });
      patch.reportColumns = columns.slice(0, 20);
    }
    const company = users.updateCompany(req.user.companyId, patch);
    res.json({ company });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Logo ────────────────────────────────────────────────────────────────────
// The company's logo, for the case PDF's cover and page headers
// (reports/expense-pdf.js). The page sends the picture as a data URL; it is
// kept as a small PNG laid on white: the PDF embeds a transparent PNG as two
// full-size pictures, a logo of a few kilobytes became sixty, and its pages
// are white anyway. Its own body parser, as for receipts, after the role check
// (index.js leaves this path to it).
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const logoJson = express.json({ limit: '3mb' });
const companyView = companyId => ({ ...users.getCompany(companyId), baseCurrencyLocked: companyHasPriced(companyId) });

router.post('/logo', requireAuth, requireRole('admin'), logoJson, asyncHandler(async (req, res) => {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUri || ''));
  if (!m) return res.status(400).json({ error: 'Choose a PNG, JPEG or WebP picture for the logo.' });
  const input = Buffer.from(m[2], 'base64');
  if (input.length > LOGO_MAX_BYTES) return res.status(413).json({ error: 'The logo is over 2 MB. Choose a smaller picture.' });
  let png;
  try {
    png = await require('sharp')(input, { limitInputPixels: 40e6 }).rotate()
      .resize({ width: 900, height: 300, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).png({ palette: true, compressionLevel: 9 }).toBuffer();
  } catch {
    return res.status(400).json({ error: 'That file could not be read as a picture.' });
  }
  users.updateCompany(req.user.companyId, { logo: `data:image/png;base64,${png.toString('base64')}` });
  logger.info('Company logo set', { companyId: req.user.companyId, bytes: png.length, by: req.user.id });
  res.json({ company: companyView(req.user.companyId) });
}));

router.delete('/logo', requireAuth, requireRole('admin'), (req, res) => {
  users.updateCompany(req.user.companyId, { logo: null });
  logger.info('Company logo removed', { companyId: req.user.companyId, by: req.user.id });
  res.json({ company: companyView(req.user.companyId) });
});

// ── LLM API keys ────────────────────────────────────────────────────────────
// Never the key itself: its first and last four characters, and what the
// reader last saw from it.
const masked = k => require('../utils/mask').maskKey(k.apiKey);
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
