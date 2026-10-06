const store        = require('../store/expenses');
const receiptStore = require('./receipt-store');

// Deleting an expense, and its stored receipt once nothing else uses it. One
// place, because the rule has two parts that are easy to get half right: the
// receipt row goes when no expense points at it, and the file goes only when
// no receipt row points at it either (an import shares one file between the
// parts of a PDF, and between a byte-identical upload and its duplicate).
//
// Returns true when a file was removed from disk.
function removeExpense(e) {
  store.deleteExpense(e.id);
  if (!e.receipt || store.countExpensesForReceipt(e.receipt.id) > 0) return false;
  let removed = false;
  if (store.countExpensesForFile(e.receipt.userId, e.receipt.file) === 0) removed = !!receiptStore.forUser(e.receipt.userId).remove(e.receipt.file);
  store.deleteReceipt(e.receipt.id);
  return removed;
}

module.exports = { removeExpense };
