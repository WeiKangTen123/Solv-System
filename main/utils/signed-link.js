// Short-lived signed links: a receipt image, an export. A browser opening a
// link cannot send the session header, so a signed-in call hands back a link
// signed for one purpose and one thing, and the link is checked again when it
// is used.
//
// One implementation for both kinds. There were two, neither of which pinned
// the signing algorithm, and neither asked anything at the moment of use: a
// link made before its holder was removed, or before an admin was demoted,
// still opened for its five minutes.
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../middleware/auth-middleware');
const { canView } = require('../middleware/roles');

const TTL = '5m';

function sign(purpose, claims) {
  return jwt.sign({ ...claims, purpose }, jwtSecret(), { expiresIn: TTL });
}

// The claims of a link made for `purpose`, or null.
function read(token, purpose) {
  try {
    const c = jwt.verify(String(token || ''), jwtSecret(), { algorithms: ['HS256'] });
    return c && c.purpose === purpose ? c : null;
  } catch { return null; }
}

// Whether the person the link was made for may still see a record owned by
// `ownerId` in `companyId`: they exist, are not removed, and pass the same
// rule as any other read.
function stillAllowed(viewerId, ownerId, companyId) {
  const live = viewerId ? require('../store/users').findSession(viewerId) : null;
  if (!live || live.removed) return false;
  return canView({ id: live.id, role: live.role, companyId: live.companyId }, ownerId, companyId);
}

module.exports = { sign, read, stillAllowed, TTL };
