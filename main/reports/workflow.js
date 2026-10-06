const db       = require('../db');
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

// Errors carry the HTTP status a route answers with: who may act is a 403,
// a state that does not allow it a 409, anything about the content a 400.
function fail(status, message) { const err = new Error(message); err.status = status; throw err; }

function _get(id) { const r = reports.getReport(id); if (!r) fail(404, 'Case not found'); return r; }
function isEditable(report) { return !!report && EDITABLE.has(report.status); }

// Locked means: in a case that has been claimed. One column, not the whole
// case: this runs on every receipt shown, and loading the case to read its
// status cost a query per receipt in it.
function isLocked(expense) {
  if (!expense || !expense.reportId) return false;
  const r = db.prepare('SELECT status FROM expense_reports WHERE id = ?').get(expense.reportId);
  return !!r && !EDITABLE.has(r.status);
}

// Being posted: the bill is on its way to Xero and not yet confirmed.
const isPosting = report => !!report && report.xeroError === 'posting';

// Posted means: in a case that is in Xero. That is final for everybody —
// details included — because the bill already exists.
function isPosted(expense) {
  if (!expense || !expense.reportId) return false;
  const r = db.prepare('SELECT xero_invoice_id FROM expense_reports WHERE id = ?').get(expense.reportId);
  return !!(r && r.xero_invoice_id);
}

// The owner's business and nobody else's. An admin watches claims; whether a
// claim went through is the claimant's to say, and an admin saying it for
// them is exactly the record this system must not be able to fake.
function _mine(r, actor, what) {
  if (!actor || r.userId !== actor.id) fail(403, `Only the claimant can ${what}`);
}

// Marking a case claimed is the owner's own record that they put it through.
// It carries the checks that submitting used to: a claim with an unchecked
// receipt or an unpriced line is not a claim anybody could have made.
function markClaimed(reportId, actor) {
  const r = _get(reportId);
  _mine(r, actor, 'mark their own case claimed');
  if (r.status !== 'open') fail(409, 'This case was already claimed');
  if (!r.expenses.length) fail(400, 'Add at least one receipt before claiming');
  const unreviewed = r.expenses.filter(e => e.status !== 'reviewed');
  if (unreviewed.length) fail(400, `${unreviewed.length} receipt${unreviewed.length === 1 ? ' is' : 's are'} not checked yet`);
  if (r.totals.pendingRates) fail(400, `${r.totals.pendingRates} receipt${r.totals.pendingRates === 1 ? ' has' : 's have'} no exchange rate yet`);
  // A receipt already put through on its own would be claimed, and paid, twice.
  const alone = r.expenses.filter(e => e.claimedAt);
  if (alone.length) fail(409, `${alone.map(e => e.merchant || 'A receipt').join(', ')} ${alone.length === 1 ? 'was' : 'were'} already claimed on ${alone.length === 1 ? 'its' : 'their'} own. Take ${alone.length === 1 ? 'it' : 'them'} out of the case first.`);
  // Reviewed once does not mean it still adds up: a total corrected after the
  // check leaves a split's lines behind, and the lines are what is paid.
  const off = r.expenses.filter(e => !expenses.linesReconcile(e.lines, expenses.toCents(e.total)));
  if (off.length) fail(400, `The lines of ${off.map(e => e.merchant || 'a receipt').join(', ')} do not add up to the receipt total`);
  const at = new Date().toISOString();
  // All of it or none of it: a failure half-way used to leave a claimed case
  // with some of its receipts unclaimed.
  db.transaction(() => {
    reports.setState(reportId, { status: 'claimed', claimedAt: at });
    // Claiming the case claims everything in it: the receipts went in together.
    for (const e of r.expenses) expenses.updateExpense(e.id, { claimedAt: at });
    reports.addEvent(reportId, actor.id, 'claimed', null);
  })();
  return reports.getReport(reportId);
}

// Mistakes happen, and record-only means nothing downstream breaks when one is
// undone. The receipts inside are unclaimed with it, for the same reason they
// were claimed with it.
function reopen(reportId, actor) {
  const r = _get(reportId);
  _mine(r, actor, 'reopen their own case');
  if (r.status !== 'claimed') fail(409, 'This case is already open');
  // Once it is in Xero it is in the books. Reopening it here let the amounts
  // change under a bill that had already been raised, and the two then
  // disagreed with nothing to say so.
  if (r.xeroInvoiceId) fail(409, 'This case has been posted to Xero and is final. Raise a new case for anything that changed.');
  // Nor while the bill is on its way: it would land on an open case.
  if (isPosting(r)) fail(409, 'This case is being posted to Xero right now. Wait for that to finish.');
  db.transaction(() => {
    reports.setState(reportId, { status: 'open', claimedAt: null });
    for (const e of r.expenses) expenses.updateExpense(e.id, { claimedAt: null });
    reports.addEvent(reportId, actor.id, 'reopened', null);
  })();
  return reports.getReport(reportId);
}

// A receipt claimed on its own — a one-off put through directly. Marking it
// does not move the case it may sit in: a case is claimed when its owner says
// the whole case is.
// The same bar a case has to clear, for a receipt claimed on its own: checked,
// and priced. And one inside a claimed case moves with its case, not alone.
function markExpenseClaimed(expenseId, actor, claimed = true) {
  const e = expenses.getExpense(expenseId);
  if (!e) fail(404, 'Expense not found');
  if (!actor || e.userId !== actor.id) fail(403, 'Only the claimant can mark their own receipt claimed');
  if (isLocked(e)) fail(409, 'This receipt is in a claimed case; it is claimed or reopened with its case');
  if (claimed) {
    // One inside a case is claimed with its case. Claiming it alone as well
    // claimed it twice: once here, and again when the case was claimed.
    if (e.reportId) fail(409, 'This receipt is in a case. Claim the case, or take the receipt out of it first.');
    if (e.status !== 'reviewed') fail(400, 'Check this receipt before marking it claimed');
    if (e.fxPending || !e.lines.length) fail(400, 'This receipt has no exchange rate yet');
    if (!expenses.linesReconcile(e.lines, expenses.toCents(e.total))) fail(400, 'The lines do not add up to the receipt total');
  }
  return expenses.updateExpense(expenseId, { claimedAt: claimed ? new Date().toISOString() : null });
}

module.exports = { markClaimed, reopen, markExpenseClaimed, isEditable, isLocked, isPosted, isPosting, EDITABLE };
