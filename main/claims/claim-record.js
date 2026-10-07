const { hashBuffer, findDuplicate } = require('../intake/dedup');
const { canonicalCategory } = require('../intake/categories');
const users  = require('../store/users');
const store  = require('../store/expenses');
const receiptStore = require('../receipts/receipt-store');
const fx     = require('../fx/apply');
const logger = require('../utils/logger');
const { currencyOf } = require('./claim-form');

// One matched claim line (a form row, a receipt, or both) becomes a receipt
// row and an expense with one line. Injected into the import job.
//
// Dedup happens here because it needs the finished figures — the claimant's
// amount and date — and because one record at a time means a repeat inside a
// single archive is caught too: the first row is committed before the second
// is checked.
async function createClaimRecord({ userId, groupId, row, receipt, match, category, store: storeFile, files = null }) {
  const me = users.findById(userId);
  const companyId = me.companyId;
  // The parts of one file (the pages of a PDF, the receipts in one photo)
  // share it. Whichever part is saved first stores the file with its hash and
  // settles whether the FILE is one already held; every later part shares the
  // stored copy and that answer. Only part 0 used to be hashed, which missed
  // both when a later part happened to be saved first (they are saved in
  // matching order), and left every later part of a re-imported PDF looking
  // new. A later part is not hashed itself: its bytes are its sibling's, and a
  // hash check would call it a duplicate of that.
  const shared = receipt && receipt.fileKey && files ? files.get(receipt.fileKey) : null;
  const hash = receipt && receipt.buffer && !shared ? hashBuffer(receipt.buffer) : null;
  // A claimed 0 is a formatted blank, not a claim of nothing: the receipt's
  // total stands, as it does when the cell is empty. It used to overwrite it.
  const claimed = row.amount != null && row.amount !== 0 ? row.amount : null;
  const dup = (shared && shared.dup) || findDuplicate({
    store: store.dedupView(companyId), profile: { dedup: { byHash: true, byNumber: false, byFields: true } }, hash,
    vendorName: (receipt && receipt.merchant) || null,
    date: row.date ?? (receipt && receipt.date) ?? null, amount: claimed ?? (receipt && receipt.total) ?? null,
  });

  let receiptId = null;
  let storeNote = null;
  // What a later part of this file needs: where it is kept, and whether it is
  // a copy of one already held.
  const remember = (file, mime) => {
    if (receipt && receipt.fileKey && files) files.set(receipt.fileKey, { file, mime, dup: dup && dup.certain ? dup : null });
  };
  if (shared) {
    const rec = store.createReceipt({ companyId, userId, file: shared.file, mime: shared.mime, sizeBytes: 0, sha256: null, source: 'import', groupId, originalName: receipt.file || null });
    store.updateReceipt(rec.id, { parsedAt: new Date().toISOString() });
    receiptId = rec.id;
  } else if (dup && dup.certain && dup.match.receiptFile && dup.match.userId === userId) {
    // A file is shared only within one person's storage: a colleague's file
    // lives in their directory, where this person's receipt would never find
    // it, so a duplicate of a colleague's receipt keeps its own copy.
    // Byte-identical to a file already held: a receipt row of its own (so this
    // import's group owns it) pointing at the SAME file. countExpensesForFile
    // keeps the file until the last expense on it is gone. It has no size of
    // its own: the bytes are counted once, on the receipt that holds them, and
    // counting them again here filled the person's quota with copies that take
    // no room.
    const rec = store.createReceipt({ companyId, userId, file: dup.match.receiptFile, mime: dup.match.receiptMime || (receipt && receipt.mime) || 'image/jpeg',
      sizeBytes: 0, sha256: hash, source: 'import', groupId, originalName: receipt && receipt.file || null });
    store.updateReceipt(rec.id, { parsedAt: new Date().toISOString() });
    receiptId = rec.id;
    remember(dup.match.receiptFile, dup.match.receiptMime || receipt.mime);
  } else if (receipt && receipt.buffer) {
    if (store.bytesStoredBy(userId) + receipt.buffer.length > receiptStore.QUOTA_BYTES) {
      storeNote = 'The receipt file was not kept: your receipt storage is full. Ask your administrator.';
    } else {
      let rec = null;
      try {
        rec = store.createReceipt({ companyId, userId, file: 'pending', mime: receipt.mime, sizeBytes: receipt.buffer.length, sha256: hash, source: 'import', groupId, originalName: receipt.file || null });
        const name = await storeFile(userId, rec.id, receipt.buffer, receipt.mime);
        store.updateReceipt(rec.id, { file: name, parsedAt: new Date().toISOString() });
        receiptId = rec.id;
        remember(name, receipt.mime);
      } catch (err) {
        logger.warn('Claim receipt could not be stored', { userId, error: err.message });
        // A row left on 'pending' carried the file's hash, and every later
        // upload of that file was refused as already held.
        if (rec) store.deleteReceipt(rec.id);
        storeNote = 'The receipt file could not be kept. Upload it again on this receipt.';
      }
    }
  }

  const ref = dup ? (dup.match.invoiceNumber || dup.match.id) : null;
  const note = dup && !dup.certain ? `Possible duplicate of ${ref} — ${dup.reason}. Check before submitting.`
    : dup ? `Duplicate of ${ref} — ${dup.reason}`
    : match && match.discrepancy ? `Claimed ${match.discrepancy.claimed} but the receipt says ${match.discrepancy.onReceipt}`
    : (!receipt && row.no ? 'No receipt found for this claim line' : null);
  // `notes` is what the reader had to say about the file as a whole ("only the
  // first 20 of 35 pages were read"), carried on its first part.
  const errorMsg = [note, storeNote, receipt && receipt.notes].filter(Boolean).join(' ') || null;

  const cat = canonicalCategory(category) || canonicalCategory(receipt && receipt.category) || null;
  const total = claimed ?? (receipt && receipt.total != null ? receipt.total : 0);
  // "S$" or "RM" typed on the form is a currency, but not a code: it is read
  // as one, and what names none gives way to the receipt's own currency.
  const currency = currencyOf(row.currency) || (receipt && currencyOf(receipt.currency)) || users.getUserDefaults(userId).currency;
  const description = row.description || (receipt && receipt.description) || (receipt && receipt.merchant) || null;

  const rec = store.createExpense({
    companyId, userId, receiptId, source: 'import',
    merchant: (receipt && receipt.merchant) || null, receiptDate: row.date || (receipt && receipt.date) || null, receiptTime: (receipt && receipt.time) || null,
    invoiceNo: (receipt && receipt.invoiceNumber) || null, currency, total, tax: receipt && receipt.tax != null ? receipt.tax : null,
    subTotal: receipt && receipt.subTotal != null ? receipt.subTotal : null, description, category: cat,
    status: dup && dup.certain ? 'duplicate' : 'review-needed', duplicateOf: dup && dup.match.id ? dup.match.id : null, errorMsg,
    importId: groupId || null, page: (receipt && receipt.page) || undefined, box: (receipt && receipt.box) || null,
    aiReadAt: receipt && receipt.readable !== false ? new Date().toISOString() : null, aiConfidence: (receipt && receipt.confidence) || null,
    lines: total > 0 ? [{ category: cat || 'Other', description, amount: total, currency }] : [],
  });
  try { await fx.applyFx(rec.id); } catch (err) { logger.warn('Exchange rate not applied on import', { id: rec.id, error: err.message }); }
  return store.getExpense(rec.id);
}

module.exports = { createClaimRecord };
