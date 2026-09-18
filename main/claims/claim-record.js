const { hashBuffer, findDuplicate } = require('../intake/dedup');
const { canonicalCategory } = require('./categories');
const users  = require('../utils/users');
const store  = require('../store/expenses');
const logger = require('../utils/logger');

// One matched claim line (a form row, a receipt, or both) becomes a receipt
// row and an expense with one line. Injected into the import job.
//
// Dedup happens here because it needs the finished figures — the claimant's
// amount and date — and because one record at a time means a repeat inside a
// single archive is caught too: the first row is committed before the second
// is checked.
async function createClaimRecord({ userId, groupId, row, receipt, match, category, store: storeFile }) {
  const me = users.findById(userId);
  const companyId = me.companyId;
  const hash = receipt && receipt.buffer ? hashBuffer(receipt.buffer) : null;
  const dup = findDuplicate({
    store: store.dedupView(companyId), profile: { dedup: { byHash: true, byNumber: false, byFields: true } }, hash,
    vendorName: (receipt && receipt.merchant) || null,
    date: row.date ?? (receipt && receipt.date) ?? null, amount: row.amount ?? (receipt && receipt.total) ?? null,
  });

  let receiptId = null;
  if (dup && dup.certain && dup.match.receiptFile) {
    // Byte-identical to a file already held: a receipt row of its own (so this
    // import's group owns it) pointing at the SAME file. countExpensesForFile
    // keeps the file until the last expense on it is gone.
    const rec = store.createReceipt({ companyId, userId, file: dup.match.receiptFile, mime: dup.match.receiptMime || (receipt && receipt.mime) || 'image/jpeg',
      sizeBytes: receipt && receipt.buffer ? receipt.buffer.length : 0, sha256: hash, source: 'import', groupId, originalName: receipt && receipt.file || null });
    store.updateReceipt(rec.id, { parsedAt: new Date().toISOString() });
    receiptId = rec.id;
  } else if (receipt && receipt.buffer) {
    try {
      const rec = store.createReceipt({ companyId, userId, file: 'pending', mime: receipt.mime, sizeBytes: receipt.buffer.length, sha256: hash, source: 'import', groupId, originalName: receipt.file || null });
      const name = await storeFile(userId, rec.id, receipt.buffer, receipt.mime);
      store.updateReceipt(rec.id, { file: name, parsedAt: new Date().toISOString() });
      receiptId = rec.id;
    } catch (err) {
      logger.warn('Claim receipt could not be stored', { userId, error: err.message });
    }
  }

  const ref = dup ? (dup.match.invoiceNumber || dup.match.id) : null;
  const note = dup && !dup.certain ? `Possible duplicate of ${ref} — ${dup.reason}. Check before submitting.`
    : dup ? `Duplicate of ${ref} — ${dup.reason}`
    : match && match.discrepancy ? `Claimed ${match.discrepancy.claimed} but the receipt says ${match.discrepancy.onReceipt}`
    : (!receipt && row.no ? 'No receipt found for this claim line' : null);

  const cat = canonicalCategory(category) || canonicalCategory(receipt && receipt.category) || null;
  const total = row.amount != null ? row.amount : (receipt && receipt.total != null ? receipt.total : 0);
  const currency = row.currency || (receipt && receipt.currency) || users.getUserDefaults(userId).currency;
  const description = row.description || (receipt && receipt.description) || (receipt && receipt.merchant) || null;

  return store.createExpense({
    companyId, userId, receiptId, source: 'import',
    merchant: (receipt && receipt.merchant) || null, receiptDate: row.date || (receipt && receipt.date) || null, receiptTime: (receipt && receipt.time) || null,
    invoiceNo: (receipt && receipt.invoiceNumber) || null, currency, total, tax: receipt && receipt.tax != null ? receipt.tax : null,
    subTotal: receipt && receipt.subTotal != null ? receipt.subTotal : null, description, category: cat,
    status: dup && dup.certain ? 'duplicate' : 'review-needed', duplicateOf: dup && dup.match.id ? dup.match.id : null, errorMsg: note,
    aiReadAt: receipt && receipt.readable !== false ? new Date().toISOString() : null, aiConfidence: (receipt && receipt.confidence) || null,
    lines: total > 0 ? [{ category: cat || 'Other', description, amount: total, currency }] : [],
  });
}

module.exports = { createClaimRecord };
