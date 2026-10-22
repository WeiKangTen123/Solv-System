const express      = require('express');
const path         = require('path');
const router       = express.Router();
const link         = require('../utils/signed-link');
const QRCode       = require('qrcode');
const { newId }    = require('../utils/ids');
const { decodeBase64 } = require('../utils/base64');
const { hashBuffer }   = require('../intake/dedup');
const { toStorable }   = require('../intake/convert');
const { HttpError }    = require('../utils/http-error');
const { requireAuth } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const { canView } = require('../middleware/roles');
const express_ = require('express');

// Receipt files arrive as base64 inside JSON (4/3 inflation): 25 MB carries a
// 15 MB original. Mounted on the three upload routes alone, and only after the
// caller is known to be allowed; index.js keeps everything else to 100 KB.
const bigJson = express_.json({ limit: '25mb' });
const users        = require('../store/users');
const store        = require('../store/expenses');
const receiptStore = require('../receipts/receipt-store');
const thumbnailer  = require('../receipts/thumbnailer');
const pairing      = require('../receipts/pairing');
const readQueue    = require('../receipts/read-queue');
const { readArchive } = require('../claims/claim-archive');
const { parseMail, receiptsFromMail, pdfName } = require('../intake/email');
const logger       = require('../utils/logger');

// A receipt FILE arrives here: dropped on the desktop, photographed on a
// paired phone, or unpacked from a zip. It is converted to what the store
// keeps (intake/convert.js), stored, an expense row is created, and its read
// is queued (receipts/read-queue.js). Nothing here reaches Xero.

// A link to one receipt's file (utils/signed-link.js): the owner, whose
// folder the file is in, and `by`, the person it was made for, who must
// still be allowed to see it when the link is opened.
function issueImageToken(ownerId, receiptId, viewerId = ownerId) {
  return link.sign('receipt', { userId: ownerId, receiptId, by: viewerId });
}

// May this person put a receipt in this case? Asked BEFORE anything is stored.
// It used to be asked after, which meant a refused upload — into a colleague's
// case, or one that had just been submitted — still wrote the file to disk,
// created the receipt and the expense, and set the reader going on them. The
// claimant saw an error and got a stray expense in their pile anyway.
//
// Unlike the bulk filing route this accepts an expense nobody has checked yet:
// that is the whole point of uploading into a case. Submit goes on refusing
// until every receipt in it has been checked, so nothing gets weaker.
function checkCase(user, reportId) {
  if (!reportId) return null;
  const r = require('../store/reports').getReport(reportId);
  if (!r || r.companyId !== user.companyId) return { error: 'Case not found', status: 404 };
  // The owner's own case only, as for every filing route: an upload creates
  // the receipt under the uploader's name, so an admin uploading into someone's
  // case put their own receipt inside that person's claim.
  if (r.userId !== user.id) return { error: 'That case belongs to someone else', status: 403 };
  if (!require('../reports/workflow').isEditable(r)) return { error: `A ${r.status} case cannot take more receipts`, status: 409 };
  return null;
}

// Stores one file for `user`, into `reportId` when given, and queues its read.
// The file is `data` (base64, from a browser) or `buffer` (from a zip).
// Answers { status, body } for everything the person sent, a refusal included.
// The browser turns what it can open itself (WebP, GIF, BMP, and HEIC in
// Safari) into JPEG before sending, and says what the file was. That is kept
// like a conversion made here, but only on a JPEG and only from these names.
const BROWSER_CONVERTED = new Set(['image/webp', 'image/gif', 'image/bmp', 'image/heic', 'image/heif', 'image/avif', 'image/tiff']);

async function storeReceipt(user, { mime: declaredMime, data, buffer: given, filename, source, reportId, convertedFrom: claimedFrom }) {
  const noCase = checkCase(user, reportId);
  if (noCase) return { status: noCase.status, body: { error: noCase.error } };
  const raw = Buffer.isBuffer(given) ? given : decodeBase64(data);
  if (!raw) return { status: 400, body: { error: 'File data is missing or not valid base64' } };
  const mb = n => `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (raw.length > receiptStore.MAX_BYTES) {
    return { status: 413, body: { error: `The file is ${mb(raw.length)}; the limit is ${mb(receiptStore.MAX_BYTES)}.` } };
  }
  // What is stored, and later served, is decided by the bytes rather than by
  // what the browser declared, and it is decided first: a HEIC is kept as the
  // JPEG it becomes, so the quota, the duplicate check and the hash are all
  // about the bytes that will be on disk. A file that is none of the accepted
  // kinds is refused, naming them.
  let kept;
  try {
    kept = await toStorable(raw, { declaredMime, filename });
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  const { buffer, mime, note } = kept;
  const convertedFrom = kept.convertedFrom || (mime === 'image/jpeg' && BROWSER_CONVERTED.has(claimedFrom) ? claimedFrom : null);
  // Converting takes a moment, and the case may have been claimed in it.
  const stillOpen = checkCase(user, reportId);
  if (stillOpen) return { status: stillOpen.status, body: { error: stillOpen.error } };
  const used = store.bytesStoredBy(user.id);
  if (used + buffer.length > receiptStore.QUOTA_BYTES) {
    return { status: 413, body: { error: `Your receipts already take ${mb(used)} of the ${mb(receiptStore.QUOTA_BYTES)} allowed. Ask your administrator.` } };
  }

  const hash = hashBuffer(buffer);
  const existing = store.findReceiptByHash(user.companyId, hash);
  if (existing) {
    const owned = store.expensesForReceipt(existing.id)[0] || null;
    logger.info('Receipt already uploaded', { userId: user.id, receiptId: existing.id });
    // A colleague's copy is named as such and nothing more: its ids were
    // handed back here, which said which of a colleague's receipts it was.
    const theirs = owned ? owned.userId !== user.id : existing.userId !== user.id;
    return { status: 409, body: theirs
      ? { error: 'This receipt was already uploaded by a colleague.' }
      : { error: `You have already uploaded this receipt${owned && owned.merchant ? ` (${owned.merchant})` : ''}.`, duplicateOf: owned ? owned.id : null, receiptId: existing.id },
    };
  }

  const receiptId = newId();
  const storedName = receiptStore.forUser(user.id).save(receiptId, buffer, mime);
  const src = source === 'phone' ? 'phone' : 'upload';
  const receipt = store.createReceipt({ id: receiptId, companyId: user.companyId, userId: user.id, file: storedName, mime, sizeBytes: buffer.length, sha256: hash, source: src, originalName: filename || null, convertedFrom });
  // A file from an email is an upload as far as the receipt row's CHECK goes;
  // the expense says where it came from.
  let expense = store.createExpense({ companyId: user.companyId, userId: user.id, receiptId, source: source === 'email' ? 'email' : src, status: 'reading', currency: users.getUserDefaults(user.id).currency });
  // Answered as filed, so the page knows which case it is in.
  if (reportId) { require('../store/reports').addExpense(reportId, expense.id); expense = store.getExpense(expense.id); }
  logger.info('Receipt stored', { userId: user.id, receiptId, bytes: buffer.length, mime, convertedFrom, source: src });

  readQueue.enqueue({ companyId: user.companyId, userId: user.id, receiptId, expenseId: expense.id });

  return { status: 201, body: { receipt, expense, imageToken: issueImageToken(user.id, receiptId), ...(note ? { note } : {}) } };
}

router.post('/', requireAuth, bigJson, asyncHandler(async (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const { status, body } = await storeReceipt(me, req.body || {});
    res.status(status).json(body);
  } catch (err) {
    logger.error('Receipt upload failed', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: 'The upload failed. Try again.' });
  }
}));

// ── A zip of receipts, unpacked into a case ─────────────────────────────────
// Every receipt in it goes through storeReceipt as if dropped one by one, so
// it is converted, checked for a duplicate and queued for reading the same
// way. A zip with a claim form in it is a claim, and the claim import matches
// the form's rows to the receipts; it is sent there instead, untouched.
const CLAIM_FORM = /\.xlsx$/i;
router.post('/archive', requireAuth, bigJson, asyncHandler(async (req, res) => {
  const me = users.findById(req.user.id);
  const { data, filename, reportId } = req.body || {};
  if (!reportId) return res.status(400).json({ error: 'Choose the case these receipts go into.' });
  const bad = checkCase(me, reportId);
  if (bad) return res.status(bad.status).json({ error: bad.error });
  const zip = decodeBase64(data);
  if (!zip) return res.status(400).json({ error: 'File data is missing or not valid base64' });
  const archive = await readArchive(zip, { convertible: true });
  if (archive.error && !archive.entries.length) return res.status(400).json({ error: 'That file is not a zip that can be opened.' });
  if (archive.skipped.some(s => CLAIM_FORM.test(s.name))) {
    return res.status(409).json({ error: 'This zip holds a claim form, so it is imported as a claim.', claimForm: true });
  }
  const stored = [], skipped = [];
  for (const entry of archive.entries) {
    const out = await storeReceipt(me, { buffer: entry.buffer, mime: entry.mime, filename: path.posix.basename(entry.name), source: 'upload', reportId });
    if (out.status === 201) stored.push({ receipt: out.body.receipt, expense: out.body.expense, imageToken: out.body.imageToken, ...(out.body.note ? { note: out.body.note } : {}) });
    else skipped.push({ name: entry.name, why: out.body.error });
  }
  for (const s of archive.skipped) skipped.push({ name: s.name, why: s.reason });
  logger.info('Receipt archive unpacked', { userId: me.id, reportId, archive: filename ? String(filename).slice(0, 120) : null, stored: stored.length, skipped: skipped.length });
  res.status(stored.length ? 201 : 200).json({ stored, skipped });
}));

// ── An email ────────────────────────────────────────────────────────────────
// The receipts in one mail (intake/email.js), each stored as if it had been
// dropped by itself: converted, checked for a duplicate and queued for
// reading the same way. A mail with nothing attached is kept as a PDF of the
// message. Used for an .eml or .msg dropped on a case, here, and for mail
// forwarded to a person's address (routes/inbound.js). `mail` is parsed.
async function storeMail(user, mail, { reportId = null } = {}) {
  const { timezone } = users.getUserDefaults(user.id);
  const { files, skipped: left, bodyPdf } = await receiptsFromMail(mail, { timeZone: timezone });
  if (bodyPdf) files.push({ buffer: bodyPdf, filename: pdfName(mail.subject), declaredMime: 'application/pdf' });
  const stored = [], skipped = [];
  for (const f of files) {
    const out = await storeReceipt(user, { buffer: f.buffer, mime: f.declaredMime, filename: f.filename, source: 'email', reportId });
    if (out.status === 201) stored.push({ receipt: out.body.receipt, expense: out.body.expense, imageToken: out.body.imageToken, ...(out.body.note ? { note: out.body.note } : {}) });
    else skipped.push({ name: f.filename || 'an unnamed attachment', why: out.body.error });
  }
  return { stored, skipped: [...skipped, ...left], subject: mail.subject || null, from: mail.from || null };
}

router.post('/email', requireAuth, bigJson, asyncHandler(async (req, res) => {
  const me = users.findById(req.user.id);
  const { data, filename, reportId } = req.body || {};
  if (!reportId) return res.status(400).json({ error: 'Choose the case these receipts go into.' });
  const bad = checkCase(me, reportId);
  if (bad) return res.status(bad.status).json({ error: bad.error });
  const raw = decodeBase64(data);
  if (!raw) return res.status(400).json({ error: 'File data is missing or not valid base64' });
  let mail;
  try {
    mail = await parseMail(raw, { filename });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  const out = await storeMail(me, mail, { reportId });
  logger.info('Email unpacked', { userId: me.id, reportId, stored: out.stored.length, skipped: out.skipped.length });
  res.status(out.stored.length ? 201 : 200).json(out);
}));

// ── The read of one receipt ─────────────────────────────────────────────────
// Its owner's alone: anyone else, an admin included, is told there is no such
// receipt rather than whose it is.
function _ownReceipt(req) {
  const r = store.getReceipt(req.params.id);
  return r && r.userId === req.user.id ? r : null;
}
function _readView(r) {
  return { receiptId: r.id, read: readQueue.statesFor([r.id]).get(r.id) || null, expenses: store.expensesForReceipt(r.id) };
}

// "Try now": a read waiting for the AI is read at once; a failed one again.
router.post('/:id/read/retry', requireAuth, (req, res) => {
  const r = _ownReceipt(req);
  if (!r) return res.status(404).json({ error: 'Receipt not found' });
  try { readQueue.retryNow(r.id); }
  catch (err) { if (err instanceof HttpError) return res.status(err.status).json({ error: err.message }); throw err; }
  res.json(_readView(r));
});

// "Stop": a read still waiting is dropped, and the receipt is the person's to fill in.
router.delete('/:id/read', requireAuth, (req, res) => {
  const r = _ownReceipt(req);
  if (!r) return res.status(404).json({ error: 'Receipt not found' });
  try { readQueue.cancel(r.id); }
  catch (err) { if (err instanceof HttpError) return res.status(err.status).json({ error: err.message }); throw err; }
  res.json(_readView(r));
});

// ── Phone pairing ───────────────────────────────────────────────────────────
function captureUrl(req, token) { return `${req.protocol}://${req.get('host')}/capture/${token}`; }

router.post('/pair', requireAuth, asyncHandler(async (req, res) => {
  try {
    const reportId = (req.body || {}).reportId || null;
    if (reportId) {
      // Checked here, not only at upload: the capture page is unauthenticated
      // and echoes the case's number and title, so an unchecked id would let
      // anyone holding the link read the name of a report that is not theirs.
      const me = users.findById(req.user.id);
      const bad = checkCase(me, reportId);
      if (bad) return res.status(bad.status).json({ error: bad.error });
    }
    const token = pairing.create(req.user.id, { reportId });
    const url   = captureUrl(req, token);
    // A PNG data URL, drawn as an <img>. It used to be SVG markup the page put
    // in with innerHTML — the one place the app rendered server text as HTML.
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
    res.status(201).json({ token, url, qr, expiresInMs: pairing.TTL_MS, maxUploads: pairing.MAX_USES });
  } catch (err) {
    res.status(500).json({ error: 'Could not create a pairing code' });
  }
}));

function _phoneView(receiptIds, withToken, userId) {
  return receiptIds.map(id => {
    const r = store.getReceipt(id);
    if (!r) return null;
    const e = store.expensesForReceipt(id)[0] || null;
    return {
      id, expenseId: e ? e.id : null, merchant: e ? e.merchant : null, total: e ? e.total : null, currency: e ? e.currency : null,
      parsed: !!r.parsedAt, unreadable: !!r.parsedAt && !(e && (e.merchant || e.total)),
      ...(withToken ? { imageToken: issueImageToken(userId, id) } : {}),
    };
  }).filter(Boolean);
}

router.get('/pair/:token', requireAuth, (req, res) => {
  if (!pairing.ownedBy(req.params.token, req.user.id)) return res.status(404).json({ error: 'Pairing not found' });
  const state = pairing.status(req.params.token);
  // Every field the caller reads, including on the dead branch: leaving
  // expiresInMs out made the dialog's countdown read NaN:NaN once the code
  // expired, with the QR still shown as if it were good.
  if (!state) return res.json({ alive: false, spent: false, uploads: 0, usesLeft: 0, expiresInMs: 0, receipts: [] });
  res.json({ alive: state.alive, spent: state.spent, uploads: state.uses, usesLeft: state.usesLeft, expiresInMs: state.expiresInMs,
             receipts: _phoneView(state.receiptIds, true, req.user.id) });
});

router.delete('/pair/:token', requireAuth, (req, res) => {
  if (!pairing.ownedBy(req.params.token, req.user.id)) return res.status(404).json({ error: 'Pairing not found' });
  pairing.revoke(req.params.token);
  res.json({ ok: true });
});

const EXPIRED = { error: 'This link has expired. Show a new QR code on your computer.' };
// A spent link (every photo it allows taken) still opens, saying so, so a
// reload of the phone page shows what was sent instead of "Link expired".
router.get('/capture/:token', (req, res) => {
  const state = pairing.status(req.params.token);
  if (!state || (!state.alive && !state.spent)) return res.status(401).json({ ok: false, ...EXPIRED });
  let openCase = null;
  if (state.reportId) {
    const r = require('../store/reports').getReport(state.reportId);
    if (r) openCase = { id: r.id, number: r.number, title: r.title || null };
  }
  res.json({ ok: true, alive: state.alive, spent: state.spent, usesLeft: state.usesLeft, expiresInMs: state.expiresInMs, reportId: state.reportId || null, case: openCase });
});
// Still answers once the link has taken its last photo: it is spent, not
// expired, and the phone keeps its list of what it sent. It used to answer 401
// after the last photo it allowed, and the page swapped that list for "Link
// expired".
router.get('/capture/:token/status', (req, res) => {
  const state = pairing.status(req.params.token);
  if (!state || (!state.alive && !state.spent)) return res.status(401).json(EXPIRED);
  res.json({ ok: true, alive: state.alive, spent: state.spent, usesLeft: state.usesLeft, expiresInMs: state.expiresInMs, reportId: state.reportId || null,
             receipts: _phoneView(state.receiptIds, false) });
});
// The token is checked BEFORE the body is read: an unknown link must not get
// to make the server parse 25 MB.
const captureGate = (req, res, next) => {
  const state = pairing.verify(req.params.token);
  // The person the link belongs to must still be able to sign in: a removed
  // account's link used to keep storing receipts under it.
  const owner = state ? users.findSession(state.userId) : null;
  if (!owner || owner.removed) { if (state) pairing.revoke(req.params.token); return res.status(401).json(EXPIRED); }
  next();
};
router.post('/capture/:token', captureGate, bigJson, asyncHandler(async (req, res) => {
  const state = pairing.verify(req.params.token);
  if (!state) return res.status(401).json(EXPIRED);
  try {
    const me = users.findById(state.userId);
    if (!me) return res.status(401).json(EXPIRED);
    const { status, body } = await storeReceipt(me, { ...(req.body || {}), source: 'phone', reportId: state.reportId || null });
    if (status === 201) pairing.consume(req.params.token, body.receipt.id);
    if (body.imageToken) delete body.imageToken;
    res.status(status).json(body);
  } catch (err) {
    logger.error('Phone upload failed', { userId: state.userId, error: err.message });
    res.status(500).json({ error: 'The upload failed. Try again.' });
  }
}));

// ── Images ──────────────────────────────────────────────────────────────────
// Company-wide used to be enough here, which meant any colleague holding a
// receipt id could mint a token and read the file. The duplicate-upload reply
// hands out exactly that id ("already uploaded by a colleague"), so it was
// reachable. Same rule as every other read: your own, or an admin's.
router.get('/:id/token', requireAuth, (req, res) => {
  const r = store.getReceipt(req.params.id);
  if (!r || !canView(req.user, r.userId, r.companyId)) return res.status(404).json({ error: 'Receipt not found' });
  res.json({ token: issueImageToken(r.userId, r.id, req.user.id) });
});

router.get('/:id/image', asyncHandler(async (req, res) => {
  const payload = link.read(req.query.token, 'receipt');
  if (!payload || payload.receiptId !== req.params.id) return res.status(401).json({ error: 'Invalid or expired image token' });
  const r = store.getReceipt(req.params.id);
  if (!r) return res.status(404).json({ error: 'Receipt not found' });
  // Asked again now, not only when the link was made: a person removed, or an
  // admin demoted, since then no longer opens it.
  if (!link.stillAllowed(payload.by || payload.userId, r.userId, r.companyId)) return res.status(401).json({ error: 'Invalid or expired image token' });
  const files = receiptStore.forUser(payload.userId);
  const filePath = files.getPath(r.file);
  if (!filePath) return res.status(404).json({ error: 'Receipt file is missing' });
  if (req.query.w) {
    const thumb = await thumbnailer.thumbnailPath(filePath, files.dir, r.file, req.query.w, r.mime);
    if (thumb) { res.type('image/jpeg'); res.setHeader('Cache-Control', 'private, max-age=86400'); return res.sendFile(thumb); }
  }
  res.type(r.mime || 'application/octet-stream');
  res.sendFile(filePath);
}));

module.exports = router;
module.exports.storeReceipt = storeReceipt;
module.exports.storeMail = storeMail;
module.exports.checkCase = checkCase;
module.exports.issueImageToken = issueImageToken;
// For tests: resolves once the read queue has nothing running and nothing due.
module.exports._drain = function _drain() { return readQueue.drain(); };
