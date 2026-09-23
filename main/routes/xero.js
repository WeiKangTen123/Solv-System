const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { requireRole } = require('../middleware/roles');
const oauthState = require('../xero/oauth-state');
const xeroOAuth  = require('../xero/oauth');
const tokenCache = require('../xero/token-cache');
const users      = require('../store/users');
const logger     = require('../utils/logger');

// The company's Xero connection: Custom Connection (client id + secret) or
// the OAuth web-app flow, exactly as in the Xero automation but owned by the
// company rather than by each user. Finance and admin manage it.
const FINANCE = requireRole('admin');   // the name stays: it is the accounting seat, and an admin holds it
const me = req => users.findById(req.user.id);

function _frontendSettingsUrl() {
  if (process.env.NODE_ENV === 'production') return '/settings';
  return `${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings`;
}

const KEYS = ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_OAUTH_CLIENT_ID', 'XERO_OAUTH_CLIENT_SECRET', 'DEFAULT_ACCOUNT_CODE'];
const SECRETS = new Set(['XERO_CLIENT_SECRET', 'XERO_OAUTH_CLIENT_SECRET']);

// GET /api/xero — status: which method, which orgs, which fields are set (secrets never returned).
router.get('/', requireAuth, (req, res) => {
  const u = me(req);
  const config = users.getCompanyConfig(u.companyId);
  const fields = Object.fromEntries(KEYS.map(k => [k, { value: SECRETS.has(k) ? '' : (config[k] || ''), isSet: !!config[k] }]));
  res.json({ connectionType: config.XERO_CONNECTION_TYPE || null, connectedAt: config.XERO_OAUTH_CONNECTED_AT || null,
             tenants: tokenCache.getPersistedTenants(u.companyId), fields, oauthRedirectConfigured: !!process.env.XERO_OAUTH_REDIRECT_URI });
});

// PATCH /api/xero/credentials — a blank secret keeps the stored one.
router.patch('/credentials', requireAuth, FINANCE, (req, res) => {
  const u = me(req);
  const patch = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!KEYS.includes(k)) continue;
    if (SECRETS.has(k) && (v === '' || v == null)) continue;
    patch[k] = v;
  }
  users.saveCompanyConfig(u.companyId, patch);
  logger.info('Xero credentials saved', { by: req.user.email, keys: Object.keys(patch) });
  res.json({ ok: true });
});

// POST /api/xero/test — Custom Connection: connect and list the orgs.
router.post('/test', requireAuth, FINANCE, async (req, res) => {
  try {
    const tenants = await require('../xero/connect').autoConnect(me(req).companyId);
    res.json({ ok: true, tenants: tenants.map(t => ({ tenantId: t.tenantId, tenantName: t.tenantName })) });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.get('/oauth/connect', requireAuth, FINANCE, (req, res) => {
  try { res.json({ url: xeroOAuth.buildAuthorizeUrl(me(req).companyId, req.user.id) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Xero's browser redirect: no auth header, so nothing privileged happens here.
// The SPA finishes the connection while signed in (see /oauth/complete).
router.get('/oauth/callback', (req, res) => {
  const { code, state, error: xeroError } = req.query;
  const base = _frontendSettingsUrl();
  if (xeroError || !code || !state) { logger.warn('Xero OAuth callback failed', { error: xeroError || 'missing code or state' }); return res.redirect(`${base}?xero_oauth=error`); }
  res.redirect(`${base}?xero_oauth=pending&code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
});

router.post('/oauth/complete', requireAuth, FINANCE, async (req, res) => {
  const { code, state } = req.body || {};
  if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });
  const bound = oauthState.consume(state);
  if (!bound || bound !== req.user.id) return res.status(400).json({ error: 'This Xero connection link is invalid or expired. Try connecting again.' });
  try { await xeroOAuth.completeConnection(me(req).companyId, code); res.json({ ok: true }); }
  catch (err) { logger.error('Xero OAuth completion failed', { error: err.message }); res.status(400).json({ error: err.message }); }
});

router.delete('/oauth/disconnect', requireAuth, FINANCE, (req, res) => {
  const u = me(req);
  const cache = tokenCache.forCompany(u.companyId);
  for (const t of cache.getAllTenants()) cache.removeTenant(t.tenant_id);
  users.saveCompanyConfig(u.companyId, { XERO_OAUTH_REFRESH_TOKEN: '', XERO_CONNECTION_TYPE: '' });
  logger.info('Xero disconnected', { by: req.user.email });
  res.json({ ok: true });
});

router.get('/tenants', requireAuth, (req, res) => {
  const u = me(req);
  res.json({ connectionType: users.getCompanyConfig(u.companyId).XERO_CONNECTION_TYPE || null, tenants: tokenCache.getPersistedTenants(u.companyId) });
});

router.get('/accounts', requireAuth, FINANCE, async (req, res) => {
  const u = me(req);
  const tenant = tokenCache.getPersistedTenants(u.companyId)[0];
  if (!tenant) return res.status(400).json({ error: 'Xero is not connected' });
  try { res.json({ accounts: await require('../xero/category-account').getAccounts(u.companyId, tenant.tenantId, { force: req.query.refresh === '1' }) }); }
  catch (err) { res.status(502).json({ error: require('../xero/xero-utils').xeroErrMsg(err) }); }
});

module.exports = router;
