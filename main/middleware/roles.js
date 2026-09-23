// Who may see whose data. A user sees their own; an admin sees the company.
// One place, so every route answers the same way.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this' });
    next();
  };
}

function canAccessUser(actor, ownerId) {
  if (!actor || !ownerId) return false;
  return actor.id === ownerId || actor.role === 'admin';
}

module.exports = { requireRole, canAccessUser };
