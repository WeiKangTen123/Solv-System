const db     = require('../db');
const store  = require('../store/expenses');
const logger = require('../utils/logger');

// Reads a restart interrupted. A read used to run inside the server process
// alone, so a deploy or a crash while one was under way left its receipt on
// 'reading' for good: nobody could edit it (the reader's answer would land on
// top), the pages polled it every few seconds until the person ran into the
// rate limit, and "Re-read" did not release it.
//
// Reads now go through the read queue (read-queue.js), whose jobs outlive a
// restart: a row still 'reading' whose receipt has a job waiting or under way
// is the queue's, and readQueue.recover() picks it up. What is left is from
// before the queue. A receipt whose first read never finished is queued again
// from its stored file, exactly as if it had just arrived; anything else — a
// split part of a file, a missing file — is released for the person to
// finish, with a note.

const NOTE = 'Reading was interrupted by a server restart. Press Re-read, or type the fields from the receipt.';

function _release(id) {
  const e = store.getExpense(id);
  if (!e || e.status !== 'reading') return;
  store.updateExpense(id, { status: 'review-needed', errorMsg: [e.errorMsg, NOTE].filter(Boolean).join(' ') });
}

// Returns { queued, released, owned }. `before` is the boot time: a row
// created after it belongs to a read that is running now.
function recoverStuckReads({ before = new Date().toISOString() } = {}) {
  const rows = db.prepare("SELECT id, receipt_id FROM expenses WHERE status = 'reading' AND created_at <= ? ORDER BY created_at").all(before);
  if (!rows.length) return { queued: 0, released: 0, owned: 0 };
  const byReceipt = new Map();
  for (const r of rows) {
    const k = r.receipt_id || `none:${r.id}`;
    if (!byReceipt.has(k)) byReceipt.set(k, []);
    byReceipt.get(k).push(r.id);
  }
  const live = new Set(db.prepare(`SELECT DISTINCT receipt_id FROM read_jobs WHERE state IN ('queued', 'reading')
                                   AND receipt_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify([...byReceipt.keys()].filter(k => !k.startsWith('none:')))).map(r => r.receipt_id));
  let queued = 0, released = 0, owned = 0;
  const readQueue = require('./read-queue');
  const receiptStore = require('./receipt-store');
  for (const [key, ids] of byReceipt) {
    if (live.has(key)) { owned += ids.length; continue; }
    const receipt = key.startsWith('none:') ? null : store.getReceipt(key);
    // Read again only the simple, common case: the file's one row, never read.
    // Split parts already exist as rows, and reading again would make more.
    const whole = receipt && !receipt.parsedAt && ids.length === 1 && store.countExpensesForReceipt(receipt.id) === 1
      && receiptStore.forUser(receipt.userId).exists(receipt.file);
    if (!whole) { for (const id of ids) _release(id); released += ids.length; continue; }
    const e = store.getExpense(ids[0]);
    readQueue.enqueue({ companyId: e.companyId, userId: e.userId, receiptId: receipt.id, expenseId: e.id });
    queued++;
  }
  logger.info('Interrupted reads recovered', { queued, released, owned });
  return { queued, released, owned };
}

module.exports = { recoverStuckReads, NOTE };
