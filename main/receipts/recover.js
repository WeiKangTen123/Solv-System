const db     = require('../db');
const store  = require('../store/expenses');
const logger = require('../utils/logger');

// Reads a restart interrupted. A read runs inside the server process, so a
// deploy or a crash while one is under way left its receipt on 'reading' for
// good: nobody could edit it (the reader's answer would land on top), the
// pages polled it every few seconds until the person ran into the rate
// limit, and "Re-read" did not release it.
//
// At boot every row still 'reading' from before the boot is one of these.
// A receipt whose first read never finished is read again from its stored
// file, exactly as if it had just arrived; anything else — a split part of a
// file, a missing file — is released for the person to finish, with a note.

const NOTE = 'Reading was interrupted by a server restart. Press Re-read, or type the fields from the receipt.';

function _release(id) {
  const e = store.getExpense(id);
  if (!e || e.status !== 'reading') return;
  store.updateExpense(id, { status: 'review-needed', errorMsg: [e.errorMsg, NOTE].filter(Boolean).join(' ') });
}

// Returns { reread, released }. `before` is the boot time: a row created after
// it belongs to a read that is running now.
async function recoverStuckReads({ before = new Date().toISOString() } = {}) {
  const rows = db.prepare("SELECT id, receipt_id FROM expenses WHERE status = 'reading' AND created_at <= ? ORDER BY created_at").all(before);
  if (!rows.length) return { reread: 0, released: 0 };
  const byReceipt = new Map();
  for (const r of rows) {
    const k = r.receipt_id || `none:${r.id}`;
    if (!byReceipt.has(k)) byReceipt.set(k, []);
    byReceipt.get(k).push(r.id);
  }
  let reread = 0, released = 0;
  const { readReceipt } = require('./read-receipt');
  const receiptStore = require('./receipt-store');
  for (const [key, ids] of byReceipt) {
    const receipt = key.startsWith('none:') ? null : store.getReceipt(key);
    // Read again only the simple, common case: the file's one row, never read.
    // Split parts already exist as rows, and reading again would make more.
    const whole = receipt && !receipt.parsedAt && ids.length === 1 && store.countExpensesForReceipt(receipt.id) === 1;
    const buffer = whole ? receiptStore.forUser(receipt.userId).read(receipt.file) : null;
    if (!buffer) { for (const id of ids) _release(id); released += ids.length; continue; }
    // readReceipt never throws: however the read ends, it releases its rows.
    const e = store.getExpense(ids[0]);
    await readReceipt({ companyId: e.companyId, userId: e.userId, receiptId: receipt.id, expenseId: e.id, buffer, mime: receipt.mime, source: receipt.source || 'upload' });
    reread++;
  }
  logger.info('Interrupted reads recovered', { reread, released });
  return { reread, released };
}

module.exports = { recoverStuckReads, NOTE };
