const logger = require('../utils/logger');
const db     = require('../db');

// Per-company in-memory token cache.
// Keyed by companyId → { tokens: { [tenantId]: { access_token, expires_at } }, tenants: [...] }
const _userCaches = new Map();

// De-dupes concurrent cold-cache reconnects per user. Access tokens are never
// persisted (see getPersistedTenants below), so every restart starts with an
// empty cache even for an already-connected user — and Insights alone fires
// 4+ requests on page load, all racing to notice the same cold cache. Xero
// rotates the refresh token on every use, so firing reconnectXero() once per
// request would have the 2nd..nth calls redeem an already-rotated (now
// stale) refresh token and fail. Sharing one in-flight promise per user
// keyed here means only the first caller actually reconnects; the rest just
// await the same result.
const _reconnecting = new Map(); // companyId -> Promise

function _getCache(companyId) {
  if (!_userCaches.has(companyId)) {
    _userCaches.set(companyId, { tokens: {}, tenants: [] });
  }
  return _userCaches.get(companyId);
}

// companyId -> in-flight refresh promise; see getValidToken.
const _refreshing = new Map();

function forCompany(companyId) {
  const cache = _getCache(companyId);

  function cacheToken(tenantId, tenantName, access_token, expires_at, connectionType = 'custom') {
    cache.tokens[tenantId] = {
      access_token,
      expires_at:      new Date(expires_at).getTime(),
      connection_type: connectionType, // 'custom' | 'oauth' — which refresh mechanism applies on expiry
    };
    if (tenantName && !cache.tenants.find(t => t.tenant_id === tenantId)) {
      cache.tenants.push({ tenant_id: tenantId, tenant_name: tenantName });
    }
    if (tenantName) {
      // Persist just the connected-org record (never the token itself) so the
      // Admin Monitoring tab can show "connected" across a server restart.
      try {
        db.prepare(`
          INSERT INTO xero_tenants (company_id, tenant_id, tenant_name, connected_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(company_id, tenant_id) DO UPDATE SET tenant_name = excluded.tenant_name
        `).run(companyId, tenantId, tenantName, new Date().toISOString());
      } catch (err) {
        logger.warn('Failed to persist xero_tenants row', { error: err.message, companyId });
      }
    }
  }

  function removeTenant(tenantId) {
    delete cache.tokens[tenantId];
    const idx = cache.tenants.findIndex(t => t.tenant_id === tenantId);
    if (idx > -1) cache.tenants.splice(idx, 1);
    try {
      db.prepare('DELETE FROM xero_tenants WHERE company_id = ? AND tenant_id = ?').run(companyId, tenantId);
    } catch (err) {
      logger.warn('Failed to remove persisted xero_tenants row', { error: err.message, companyId });
    }
    logger.info('Tenant removed from cache', { tenantId, companyId });
  }

  async function getValidToken(tenantId) {
    let mem = cache.tokens[tenantId];
    if (!mem) {
      let inFlight = _reconnecting.get(companyId);
      if (!inFlight) {
        inFlight = require('./reconnect').reconnectXero(companyId).finally(() => _reconnecting.delete(companyId));
        _reconnecting.set(companyId, inFlight);
      }
      try {
        await inFlight;
      } catch (err) {
        throw new Error(`No Xero token for tenant ${tenantId} — reconnect Xero first (${err.message})`);
      }
      mem = cache.tokens[tenantId];
      if (!mem) throw new Error(`No Xero token for tenant ${tenantId} — reconnect Xero first`);
    }
    if (Date.now() < mem.expires_at - 60_000) return mem.access_token;

    // One refresh per user at a time, shared by everyone who hits the expiry
    // together — the same shape as the cold-cache reconnect above. An OAuth
    // refresh ROTATES the refresh token, so a second concurrent refresh with
    // the same token failed with invalid_grant and surfaced as 500s on the
    // dashboard. One connection means one token: every tenant on it gets the
    // new one, not only the tenant that happened to ask.
    let refreshing = _refreshing.get(companyId);
    if (!refreshing) {
      logger.info('Token expired — refreshing', { tenantId, companyId, connectionType: mem.connection_type });
      const refresh = mem.connection_type === 'oauth'
        ? require('./oauth').refreshAuthCodeToken
        : require('./connect').refreshClientCredentialsToken;
      refreshing = refresh(companyId).then(({ access_token, expires_at }) => {
        for (const [tid, m] of Object.entries(cache.tokens)) {
          if (m.connection_type === mem.connection_type) cacheToken(tid, null, access_token, expires_at, m.connection_type);
        }
        return access_token;
      }).finally(() => _refreshing.delete(companyId));
      _refreshing.set(companyId, refreshing);
    }
    return refreshing;
  }

  // Drops every org Xero no longer lists for this connection, in memory and
  // in xero_tenants. Rows were only ever removed by an explicit disconnect,
  // so an org removed on Xero's side stayed "connected" here and could be
  // picked as the default tenant forever.
  function pruneTenants(keepTenantIds) {
    const keep = new Set((keepTenantIds || []).map(String));
    for (const tid of Object.keys(cache.tokens)) if (!keep.has(tid)) delete cache.tokens[tid];
    cache.tenants = cache.tenants.filter(t => keep.has(String(t.tenant_id)));
    try {
      const rows = db.prepare('SELECT tenant_id FROM xero_tenants WHERE company_id = ?').all(companyId);
      const del  = db.prepare('DELETE FROM xero_tenants WHERE company_id = ? AND tenant_id = ?');
      for (const r of rows) if (!keep.has(String(r.tenant_id))) { del.run(companyId, r.tenant_id); logger.info('Tenant no longer listed by Xero — removed', { tenantId: r.tenant_id, companyId }); }
    } catch (err) {
      logger.warn('Failed to prune xero_tenants rows', { error: err.message, companyId });
    }
  }

  function getAllTenants() { return cache.tenants; }

  function clear() { cache.tokens = {}; cache.tenants = []; }

  return { cacheToken, removeTenant, getValidToken, getAllTenants, pruneTenants, clear };
}

// Read-only: the last-known connected orgs for a user, persisted across restarts.
// Used only for display (Admin Monitoring tab) — never for deciding whether a live
// token is available, since access tokens themselves are never persisted.
function getPersistedTenants(companyId) {
  return db.prepare('SELECT tenant_id AS tenantId, tenant_name AS tenantName, connected_at AS connectedAt FROM xero_tenants WHERE company_id = ? ORDER BY connected_at')
    .all(companyId);
}

module.exports = { forCompany, getPersistedTenants };
