// Guessing a password, slowed per account, without letting a stranger lock an
// account against its owner.
//
// Ten wrong passwords for one email from one address lock that address out of
// that email for fifteen minutes. The lock used to be on the email alone: ten
// bad tries from one address every quarter of an hour kept everybody out, the
// only admin included, and an admin resetting the password did not lift it.
//
// A guess spread over many addresses still locks the email once it passes
// SPREAD_AFTER failures, but not for an address that has signed in to that
// account before: the owner's usual places keep working. An admin setting a
// new password, or restoring the account, clears all of it.
//
// Signing in and "change my password" (which checks the current one) share it,
// so a stolen session cannot guess the password a different way.
//
// In memory, like the address limiter: a restart forgets it.
const LOCK_AFTER = 10;
const SPREAD_AFTER = 50;
const WINDOW_MS = 15 * 60 * 1000;
const TRUSTED_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_AT = 5000;

const _pairs = new Map();     // `${email}|${ip}` -> { count, first, lockedUntil }
const _emails = new Map();    // email -> { count, first, lockedUntil }
const _trusted = new Map();   // `${email}|${ip}` -> when it last signed in

const norm = email => String(email || '').trim().toLowerCase();
const pairKey = (email, ip) => `${norm(email)}|${ip || ''}`;

function _isLocked(map, key, now) {
  const f = map.get(key);
  if (!f) return false;
  if (f.lockedUntil > now) return true;
  if (now - f.first > WINDOW_MS) map.delete(key);
  return false;
}

function _bump(map, key, limit, now) {
  const f = map.get(key);
  const cur = f && now - f.first <= WINDOW_MS ? f : { count: 0, first: now, lockedUntil: 0 };
  cur.count++;
  if (cur.count >= limit) cur.lockedUntil = now + WINDOW_MS;
  map.set(key, cur);
  if (map.size > PRUNE_AT) for (const [k, v] of map) if (now - v.first > WINDOW_MS && v.lockedUntil <= now) map.delete(k);
}

function locked(email, ip) {
  const now = Date.now();
  const pair = pairKey(email, ip);
  if (_isLocked(_pairs, pair, now)) return true;
  if (!_isLocked(_emails, norm(email), now)) return false;
  const seen = _trusted.get(pair);
  return !(seen && now - seen < TRUSTED_MS);
}

function failed(email, ip) {
  const now = Date.now();
  _bump(_pairs, pairKey(email, ip), LOCK_AFTER, now);
  _bump(_emails, norm(email), SPREAD_AFTER, now);
}

function succeeded(email, ip) {
  const pair = pairKey(email, ip);
  _pairs.delete(pair);
  _trusted.set(pair, Date.now());
  if (_trusted.size > PRUNE_AT) for (const [k, at] of _trusted) if (Date.now() - at > TRUSTED_MS) _trusted.delete(k);
}

function clear(email) {
  const e = norm(email);
  for (const k of _pairs.keys()) if (k.startsWith(`${e}|`)) _pairs.delete(k);
  _emails.delete(e);
}

function _reset() { _pairs.clear(); _emails.clear(); _trusted.clear(); }

module.exports = { locked, failed, succeeded, clear, _reset, LOCK_AFTER, SPREAD_AFTER, WINDOW_MS };
