const reports  = require('../store/reports');
const users    = require('../store/users');
const expenses = require('../store/expenses');

// The report state machine and who may move it.
//   draft → submitted → approved → claimed → posted
//              ↓            ↓
//           rejected ← ─ ─ ┘ (finance may reject an approved report before it is claimed)
//   rejected → submitted (the owner edits and resubmits)
//
// The last step is the claimant's, not finance's. This system records claims;
// it does not move money, so it cannot know that anybody was paid. What it can
// know is that the person put an approved claim through — so they say so.
const EDITABLE = new Set(['draft', 'rejected']);

function _get(id) { const r = reports.getReport(id); if (!r) throw new Error('Report not found'); return r; }
function isEditable(report) { return !!report && EDITABLE.has(report.status); }

// Locked means: filed in a report that has left the owner's hands.
function isLocked(expense) {
  if (!expense || !expense.reportId) return false;
  const r = reports.getReport(expense.reportId);
  return !!r && !EDITABLE.has(r.status);
}

// May this person approve or reject this report? Their direct reports'
// reports, or anyone's for finance and admin — but never their own.
function canDecide(reportId, actor) {
  const r = _get(reportId);
  if (r.userId === actor.id) return false;
  if (actor.role === 'finance' || actor.role === 'admin') return true;
  return actor.role === 'manager' && users.reportsTo(r.userId, actor.id);
}

function submit(reportId, actor) {
  const r = _get(reportId);
  if (r.userId !== actor.id && actor.role !== 'admin') throw new Error('Only the report owner can submit it');
  if (!EDITABLE.has(r.status)) throw new Error(`This report was already ${r.status}`);
  if (!r.expenses.length) throw new Error('Add at least one expense before submitting');
  const unreviewed = r.expenses.filter(e => e.status !== 'reviewed');
  if (unreviewed.length) throw new Error(`${unreviewed.length} expense${unreviewed.length === 1 ? ' is' : 's are'} not marked reviewed yet`);
  if (r.totals.pendingRates) throw new Error(`${r.totals.pendingRates} expense${r.totals.pendingRates === 1 ? ' has' : 's have'} no exchange rate yet`);
  reports.setState(reportId, { status: 'submitted', submittedAt: new Date().toISOString(), rejectedReason: null });
  reports.addEvent(reportId, actor.id, 'submitted', null);
  return reports.getReport(reportId);
}

function _decideGuard(r, actor) {
  if (r.userId === actor.id) throw new Error('You cannot decide on your own report');
  if (!canDecide(r.id, actor)) throw new Error("Only the claimant's manager, finance or an admin can decide this report");
}

function approve(reportId, actor) {
  const r = _get(reportId);
  _decideGuard(r, actor);
  if (r.status !== 'submitted') throw new Error(`A ${r.status} report cannot be approved`);
  reports.setState(reportId, { status: 'approved', approvedBy: actor.id, approvedAt: new Date().toISOString() });
  reports.addEvent(reportId, actor.id, 'approved', null);
  return reports.getReport(reportId);
}

function reject(reportId, actor, reason) {
  const r = _get(reportId);
  _decideGuard(r, actor);
  if (!['submitted', 'approved'].includes(r.status)) throw new Error(`A ${r.status} report cannot be rejected`);
  if (r.status === 'approved' && !(actor.role === 'finance' || actor.role === 'admin')) throw new Error('Only finance can reject an approved report');
  if (!reason || !String(reason).trim()) throw new Error('Give the claimant a reason');
  const text = String(reason).trim().slice(0, 500);
  reports.setState(reportId, { status: 'rejected', rejectedReason: text, approvedBy: null, approvedAt: null });
  reports.addEvent(reportId, actor.id, 'rejected', text);
  return reports.getReport(reportId);
}

// Marking it claimed is the owner's own record that they have put an approved
// claim through. Nobody else's business, so nobody else may do it — except an
// admin, who has to be able to tidy up after somebody who has left.
function markClaimed(reportId, actor) {
  const r = _get(reportId);
  if (r.userId !== actor.id && actor.role !== 'admin') throw new Error('Only the claimant can mark their own report claimed');
  if (!['approved', 'posted'].includes(r.status)) throw new Error('A report must be approved before it can be claimed');
  const at = new Date().toISOString();
  reports.setState(reportId, { status: 'claimed', claimedAt: at });
  // Claiming the report claims everything in it: the receipts went in together.
  for (const e of r.expenses) expenses.updateExpense(e.id, { claimedAt: at });
  reports.addEvent(reportId, actor.id, 'claimed', null);
  return reports.getReport(reportId);
}

// A receipt claimed on its own, outside any report — a one-off someone put
// through directly. Marking it does not move the report it may sit in: a case
// is claimed when its owner says the whole case is.
function markExpenseClaimed(expenseId, actor, claimed = true) {
  const e = expenses.getExpense(expenseId);
  if (!e) throw new Error('Expense not found');
  if (e.userId !== actor.id && actor.role !== 'admin') throw new Error('Only the claimant can mark their own receipt claimed');
  return expenses.updateExpense(expenseId, { claimedAt: claimed ? new Date().toISOString() : null });
}

module.exports = { submit, approve, reject, markClaimed, markExpenseClaimed, canDecide, isEditable, isLocked, EDITABLE };
