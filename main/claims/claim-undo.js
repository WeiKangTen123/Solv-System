const store   = require('../store/expenses');
const reports = require('../store/reports');
const wf      = require('../reports/workflow');
const { removeExpense } = require('../receipts/remove');

// Undoing a claim import: every row it made, and every file nothing else uses.
// Used by the Undo button, and by an import that runs again after a restart,
// which first clears what its last attempt saved so nothing is made twice.
//
// Undo reaches only what is still the claimant's to undo: a row in a claimed
// case stays, because pulling it out would make the case's total quietly
// smaller than what was put through. The case the import made goes too once
// it is empty and still open.
function undoImport(userId, importId) {
  const members = store.listExpenses({ importId, userId });
  const kept = members.filter(e => wf.isLocked(e));
  const cases = [...new Set(members.map(e => e.reportId).filter(Boolean))];
  let files = 0;
  for (const e of members) {
    if (wf.isLocked(e)) continue;
    if (removeExpense(e)) files++;
  }
  let casesRemoved = 0;
  for (const id of cases) {
    const c = reports.getReport(id);
    if (c && c.userId === userId && c.kind === 'case' && wf.isEditable(c) && !c.expenses.length) { reports.deleteReport(id); casesRemoved++; }
  }
  return { found: members.length, removed: members.length - kept.length, kept, files, casesRemoved };
}

module.exports = { undoImport };
