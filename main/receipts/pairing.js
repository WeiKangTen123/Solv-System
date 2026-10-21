const crypto = require('crypto');
const db = require('../db');

// Short-lived pairing tokens that let a phone upload receipts without logging in.
//
// The problem is the same one oauth-state.js solves: a plain browser navigation
// carries no Authorization header, so the token in the URL IS the auth boundary.
//
// The token grants UPLOAD ONLY for one user. It cannot read an existing receipt,
// list anything, or reach any other route. That is what makes a credential in a
// URL, displayed on screen as a QR code, an acceptable trade.
//
// Kept in phone_pairings rather than in memory: a deploy used to cut off
// whoever was half-way through photographing a stack of receipts, and the
// phone said "Link expired" with no way to tell why. Only a hash of the token
// is stored, so the table is no use to anyone who reads it.
const TTL_MS = 30 * 60 * 1000;

// Deliberately NOT single-use. A user photographing a stack of receipts should
// scan once and keep shooting; forcing a rescan per receipt would make the
// feature annoying enough to go unused. The exposure is bounded three ways
// instead: a half-hour life that each upload extends, a cap on uploads, and
// explicit revocation when the desktop closes the dialog.
const MAX_USES = 50;

// Live codes one person may hold at once. Opening the dialog again mints a new
// one; past this the oldest is retired, so a script cannot fill the table.
const MAX_LIVE_PER_USER = 3;

const _hash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const _iso = ms => new Date(ms).toISOString();
const _ok = token => typeof token === 'string' && token.length > 0;

// The row for a token, or null. A revoked one is gone as far as anyone asking
// is concerned.
function _row(token) {
  if (!_ok(token)) return null;
  return db.prepare('SELECT * FROM phone_pairings WHERE token_hash = ? AND revoked_at IS NULL').get(_hash(token)) || null;
}
const _receiptIds = row => { try { return JSON.parse(row.receipt_ids || '[]'); } catch { return []; } };
const _expiresIn = row => Date.parse(row.expires_at) - Date.now();

function _sweepExpired() {
  db.prepare('DELETE FROM phone_pairings WHERE expires_at <= ?').run(_iso(Date.now()));
}

// `reportId` points the session at one case: everything photographed while it
// is open lands there instead of in the loose pile. Open the case, scan once,
// and every receipt at the airport is in the right place before you land.
function create(userId, { reportId = null } = {}) {
  _sweepExpired();
  const uid = String(userId);
  const now = Date.now();
  const live = db.prepare('SELECT token_hash FROM phone_pairings WHERE user_id = ? AND revoked_at IS NULL ORDER BY expires_at, created_at')
    .all(uid).map(r => r.token_hash);
  // 32 bytes: this is a bearer credential, not a nonce, so it is sized to resist
  // guessing rather than just collision.
  const token = crypto.randomBytes(32).toString('base64url');
  db.transaction(() => {
    for (const hash of live.slice(0, Math.max(0, live.length - MAX_LIVE_PER_USER + 1))) {
      db.prepare('UPDATE phone_pairings SET revoked_at = ? WHERE token_hash = ?').run(_iso(now), hash);
    }
    db.prepare(`INSERT INTO phone_pairings (token_hash, user_id, report_id, created_at, expires_at, uses, max_uses, receipt_ids)
                VALUES (?, ?, ?, ?, ?, 0, ?, '[]')`).run(_hash(token), uid, reportId || null, _iso(now), _iso(now + TTL_MS), MAX_USES);
  })();
  return token;
}

// Returns { userId, usesLeft, expiresInMs } for a live token, else null.
// Does NOT consume — the phone validates before showing a camera, and that
// check must not spend an upload.
function verify(token) {
  const row = _row(token);
  if (!row) return null;
  if (_expiresIn(row) <= 0) { _sweepExpired(); return null; }
  if (row.uses >= row.max_uses) return null;
  return {
    reportId: row.report_id || null,
    userId: row.user_id,
    usesLeft: row.max_uses - row.uses,
    expiresInMs: _expiresIn(row),
    // What arrived through THIS pairing, so the desktop can show the photos
    // rather than only a count.
    receiptIds: _receiptIds(row),
  };
}

// Call after a successful upload. Returns the updated state, or null if the
// token died between verify and here.
function consume(token, receiptId = null) {
  const row = _row(token);
  if (!row) return null;
  const ids = _receiptIds(row);
  if (receiptId) ids.push(receiptId);
  // Sliding expiry, the way a session timeout works. Someone photographing a
  // stack of receipts should not be cut off mid-way, while a QR left abandoned
  // on screen still dies in TTL_MS because nothing is extending it. The upload
  // cap and revoke-on-close stop this from running forever.
  db.prepare('UPDATE phone_pairings SET uses = uses + 1, expires_at = ?, receipt_ids = ? WHERE token_hash = ?')
    .run(_iso(Date.now() + TTL_MS), JSON.stringify(ids), row.token_hash);
  // Hitting the cap ends the pairing, but the desktop still needs one last poll
  // to show what came through, so the row is kept until it expires naturally.
  const uses = row.uses + 1;
  return { uses, usesLeft: Math.max(0, row.max_uses - uses), receiptIds: ids };
}

// Read-only view for the pairing's OWNER, used to render what arrived. Kept
// separate from verify() on purpose: verify AUTHORISES an upload and must refuse
// a spent token, while this only describes one and can still report a token that
// has used its whole budget. Merging them once let uploads continue past the cap.
function status(token) {
  const row = _row(token);
  if (!row) return null;
  if (_expiresIn(row) <= 0) { _sweepExpired(); return null; }
  return {
    reportId: row.report_id || null,
    alive: row.uses < row.max_uses,
    spent: row.uses >= row.max_uses,
    uses: row.uses,
    usesLeft: Math.max(0, row.max_uses - row.uses),
    expiresInMs: Math.max(0, _expiresIn(row)),
    receiptIds: _receiptIds(row),
  };
}

// The desktop revokes when the dialog closes, so a QR code that was on screen
// stops working the moment the user is done with it.
function revoke(token) {
  if (!_ok(token)) return false;
  return db.prepare('UPDATE phone_pairings SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(_iso(Date.now()), _hash(token)).changes > 0;
}
// Every phone link a person has. Signing out, a new password and removal end
// their sessions; their phone links used to outlive all three, still storing
// receipts (and spending the company's reader quota) under the account.
function revokeForUser(userId) {
  return db.prepare('UPDATE phone_pairings SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(_iso(Date.now()), String(userId)).changes;
}

// Only the owner may revoke or inspect — a token is not a capability to manage
// other people's pairings.
function ownedBy(token, userId) {
  const row = _row(token);
  return !!row && row.user_id === String(userId);
}

function activeCount() {
  _sweepExpired();
  return db.prepare('SELECT COUNT(*) AS n FROM phone_pairings WHERE revoked_at IS NULL').get().n;
}
function _reset() { db.prepare('DELETE FROM phone_pairings').run(); }

module.exports = { create, verify, status, consume, revoke, revokeForUser, ownedBy, activeCount, TTL_MS, MAX_USES, MAX_LIVE_PER_USER, _reset };
