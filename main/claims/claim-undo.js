const db      = require('../db');
const store   = require('../store/expenses');
const reports = require('../store/reports');
const wf      = require('../reports/workflow');
const receiptStore = require('../receipts/receipt-store');
const { removeExpense } = require('../receipts/remove');

// Undoing a claim import: every row it made, and every file nothing else uses.
// Used by the Undo button, by an import that runs again after a restart, which
// first clears what its last attempt saved so nothing is made twice, and by an
// import that is cancelled or fails part-way through saving.
//
// Undo reaches only what is still the claimant's to undo: a row in a claimed
// case stays, because pulling it out would make the case's total quietly
// smaller than what was put through. The case the import made goes too once
// it is empty and still open — but not one that was there before it, such as
// the case the import was started from, which is the claimant's own.
function undoImport(userId, importId) {
  const members = store.listExpenses({ importId, userId });
  const kept = members.filter(e => wf.isLocked(e));
  const cases = [...new Set(members.map(e => e.reportId).filter(Boolean))];
  const since = members.reduce((first, e) => (!first || String(e.createdAt) < first ? String(e.createdAt) : first), null);
  let files = 0;
  for (const e of members) {
    if (wf.isLocked(e)) continue;
    if (removeExpense(e)) files++;
  }
  // Receipt rows the import made that no expense points at: a file stored
  // before its expense could be written, by an attempt that stopped in
  // between, or a row still on 'pending'. Nothing lists them and nothing else
  // would ever remove them, and they counted against the person's storage
  // (and, on 'pending', refused every later upload of that file) for good.
  const orphans = db.prepare(`SELECT id, file FROM receipts r WHERE r.group_id = ? AND r.user_id = ?
                              AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.receipt_id = r.id)`).all(importId, userId);
  for (const r of orphans) {
    store.deleteReceipt(r.id);
    if (r.file && store.countExpensesForFile(userId, r.file) === 0 && receiptStore.forUser(userId).remove(r.file)) files++;
  }
  let casesRemoved = 0;
  for (const id of cases) {
    const c = reports.getReport(id);
    if (c && c.userId === userId && c.kind === 'case' && wf.isEditable(c) && !c.expenses.length && String(c.createdAt) >= since) { reports.deleteReport(id); casesRemoved++; }
  }
  return { found: members.length, removed: members.length - kept.length, kept, files, casesRemoved, orphans: orphans.length };
}

module.exports = { undoImport };
