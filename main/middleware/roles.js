// Who may see or act on whose data. Employees see their own; a manager sees
// their direct reports; finance and admin see the company. One place, so every
// route answers the same way.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this' });
    next();
  };
}

function canAccessUser(actor, ownerId, users = require('../store/users')) {
  if (!actor || !ownerId) return false;
  if (actor.id === ownerId) return true;
  if (actor.role === 'finance' || actor.role === 'admin') return true;
  if (actor.role === 'manager') return users.reportsTo(ownerId, actor.id);
  return false;
}

module.exports = { requireRole, canAccessUser };
