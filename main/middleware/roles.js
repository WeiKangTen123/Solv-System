// Who may see and do what. Two roles, and one place that says so, so every
// route answers the same way.
//
//   user   their own receipts and cases, start to finish
//   admin  runs the system: people, settings, keys, rates, the Xero
//          connection, and watching usage. Sees everyone's claims in the
//          company to monitor them, and may correct a receipt's details when
//          checking one. Never files, checks, claims, reopens, deletes or posts
//          anybody else's claim: those are the claimant's.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this' });
    next();
  };
}

// The same company, always. A record from another company is invisible to
// everyone, admins included — harmless while there is one company, and the
// whole difference the day there are two.
function _sameCompany(actor, companyId) {
  if (!companyId || !actor.companyId) return true;     // callers that pass no company (tests, scripts)
  return actor.companyId === companyId;
}

// May this person SEE a record owned by `ownerId` in `companyId`?
function canAccessUser(actor, ownerId, companyId = null) {
  if (!actor || !ownerId) return false;
  if (!_sameCompany(actor, companyId)) return false;
  return actor.id === ownerId || actor.role === 'admin';
}
const canView = canAccessUser;

// May this person ACT on it? Only the owner.
function isOwner(actor, ownerId, companyId = null) {
  return !!actor && !!ownerId && actor.id === ownerId && _sameCompany(actor, companyId);
}

// May this person correct a receipt's details? The owner, and an admin of
// the same company checking it.
const canEditDetails = canAccessUser;

module.exports = { requireRole, canAccessUser, canView, isOwner, canEditDetails };
