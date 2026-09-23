const reports  = require('../store/reports');
const expenses = require('../store/expenses');

// The case state machine, and who may move it.
//
//   open ──→ claimed          the owner, once every receipt is checked and priced
//   open ←── claimed          reopen, if it was marked by mistake
//
// That is all of it. This system records claims; it does not route them
// through anybody, so there is nobody to submit to, approve, or reject. A case
// is open while receipts are still going in and claimed once its owner has
// put it through whatever actually reimburses them. Claimed locks it.
const EDITABLE = new Set(['open']);

function _get(id) { const r = reports.getReport(id); if (!r) throw new Error('Case not found'); return r; }
function isEditable(report) { return !!report && EDITABLE.has(report.status); }

// Locked means: in a case that has been claimed.
function isLocked(expense) {
  if (!expense || !expense.reportId) return false;
  const r = reports.getReport(expense.reportId);
  return !!r && !EDITABLE.has(r.status);
}

// The owner's business, and an admin's for tidying up after somebody who has
// left. Nobody else may say another person's claim went through.
function _mine(r, actor, what) {
  if (r.userId !== actor.id && actor.role !== 'admin') throw new Error(`Only the claimant can ${what}`);
}

// Marking a case claimed is the owner's own record that they put it through.
// It carries the checks that submitting used to: a claim with an unchecked
// receipt or an unpriced line is not a claim anybody could have made.
function markClaimed(reportId, actor) {
  const r = _get(reportId);
  _mine(r, actor, 'mark their own case claimed');
  if (r.status !== 'open') throw new Error('This case was already claimed');
  if (!r.expenses.length) throw new Error('Add at least one receipt before claiming');
  const unreviewed = r.expenses.filter(e => e.status !== 'reviewed');
  if (unreviewed.length) throw new Error(`${unreviewed.length} receipt${unreviewed.length === 1 ? ' is' : 's are'} not checked yet`);
  if (r.totals.pendingRates) throw new Error(`${r.totals.pendingRates} receipt${r.totals.pendingRates === 1 ? ' has' : 's have'} no exchange rate yet`);
  const at = new Date().toISOString();
  reports.setState(reportId, { status: 'claimed', claimedAt: at });
  // Claiming the case claims everything in it: the receipts went in together.
  for (const e of r.expenses) expenses.updateExpense(e.id, { claimedAt: at });
  reports.addEvent(reportId, actor.id, 'claimed', null);
  return reports.getReport(reportId);
}

// Mistakes happen, and record-only means nothing downstream breaks when one is
// undone. The receipts inside are unclaimed with it, for the same reason they
// were claimed with it.
function reopen(reportId, actor) {
  const r = _get(reportId);
  _mine(r, actor, 'reopen their own case');
  if (r.status !== 'claimed') throw new Error('This case is already open');
  reports.setState(reportId, { status: 'open', claimedAt: null });
  for (const e of r.expenses) expenses.updateExpense(e.id, { claimedAt: null });
  reports.addEvent(reportId, actor.id, 'reopened', null);
  return reports.getReport(reportId);
}

// A receipt claimed on its own — a one-off put through directly. Marking it
// does not move the case it may sit in: a case is claimed when its owner says
// the whole case is.
function markExpenseClaimed(expenseId, actor, claimed = true) {
  const e = expenses.getExpense(expenseId);
  if (!e) throw new Error('Expense not found');
  if (e.userId !== actor.id && actor.role !== 'admin') throw new Error('Only the claimant can mark their own receipt claimed');
  return expenses.updateExpense(expenseId, { claimedAt: claimed ? new Date().toISOString() : null });
}

module.exports = { markClaimed, reopen, markExpenseClaimed, isEditable, isLocked, EDITABLE };
