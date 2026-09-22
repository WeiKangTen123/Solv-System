const express      = require('express');
const router       = express.Router();
const jwt          = require('jsonwebtoken');
const QRCode       = require('qrcode');
const { newId }    = require('../utils/ids');
const { decodeBase64 } = require('../utils/base64');
const { hashBuffer }   = require('../intake/dedup');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const { canAccessUser } = require('../middleware/roles');
const users        = require('../store/users');
const store        = require('../store/expenses');
const receiptStore = require('../receipts/receipt-store');
const thumbnailer  = require('../receipts/thumbnailer');
const pairing      = require('../receipts/pairing');
const { readReceipt } = require('../receipts/read-receipt');
const logger       = require('../utils/logger');

// A receipt FILE arrives here: dropped on the desktop or photographed on a
// paired phone. It is stored first, an expense row is created, and the read
// runs off the response path. Nothing here reaches Xero.

const IMAGE_TOKEN_TTL = '5m';
function issueImageToken(userId, receiptId) {
  return jwt.sign({ userId, receiptId, purpose: 'receipt' }, jwtSecret(), { expiresIn: IMAGE_TOKEN_TTL });
}
function verifyImageToken(token, receiptId) {
  const payload = jwt.verify(token, jwtSecret());
  if (payload.purpose !== 'receipt' || payload.receiptId !== receiptId) throw new Error('Token scope mismatch');
  return payload;
}

// Reads still running, so a test can wait for them.
const _inflight = new Set();

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
  if (r.userId !== user.id && user.role !== 'admin') return { error: 'That case belongs to someone else', status: 403 };
  if (!require('../reports/workflow').isEditable(r)) return { error: `A ${r.status} case cannot take more receipts`, status: 409 };
  return null;
}

function storeReceipt(user, { mime, data, filename, source, reportId }) {
  const noCase = checkCase(user, reportId);
  if (noCase) return { status: noCase.status, body: { error: noCase.error } };
  if (!receiptStore.isAcceptedMime(mime)) {
    return { status: 400, body: { error: `Unsupported file type${mime ? ` (${mime})` : ''}. Accepted: ${receiptStore.acceptedMimes().join(', ')}.` } };
  }
  const buffer = decodeBase64(data);
  if (!buffer) return { status: 400, body: { error: 'File data is missing or not valid base64' } };
  if (buffer.length > receiptStore.MAX_BYTES) {
    const mb = n => `${(n / 1024 / 1024).toFixed(1)}MB`;
    return { status: 413, body: { error: `The file is ${mb(buffer.length)}; the limit is ${mb(receiptStore.MAX_BYTES)}.` } };
  }

  const hash = hashBuffer(buffer);
  const existing = store.findReceiptByHash(user.companyId, hash);
  if (existing) {
    const owned = store.expensesForReceipt(existing.id)[0] || null;
    logger.info('Receipt already uploaded', { userId: user.id, receiptId: existing.id });
    return { status: 409, body: {
      error: owned && owned.userId !== user.id ? 'This receipt was already uploaded by a colleague.' : `You have already uploaded this receipt${owned && owned.merchant ? ` (${owned.merchant})` : ''}.`,
      duplicateOf: owned ? owned.id : null, receiptId: existing.id,
    } };
  }

  const receiptId = newId();
  const storedName = receiptStore.forUser(user.id).save(receiptId, buffer, mime);
  const src = source === 'phone' ? 'phone' : 'upload';
  const receipt = store.createReceipt({ id: receiptId, companyId: user.companyId, userId: user.id, file: storedName, mime, sizeBytes: buffer.length, sha256: hash, source: src, originalName: filename || null });
  const expense = store.createExpense({ companyId: user.companyId, userId: user.id, receiptId, source: src, status: 'reading', currency: users.getUserDefaults(user.id).currency });
  if (reportId) require('../store/reports').addExpense(reportId, expense.id);
  logger.info('Receipt stored', { userId: user.id, receiptId, bytes: buffer.length, mime, source: src });

  const done = new Promise(resolve => setImmediate(() => {
    readReceipt({ companyId: user.companyId, userId: user.id, receiptId, expenseId: expense.id, buffer, mime, source: src })
      .catch(err => logger.warn('Receipt read failed', { userId: user.id, receiptId, error: err.message }))
      .finally(resolve);
  }));
  _inflight.add(done);
  done.finally(() => _inflight.delete(done));

  return { status: 201, body: { receipt, expense, imageToken: issueImageToken(user.id, receiptId) } };
}

router.post('/', requireAuth, (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const { status, body } = storeReceipt(me, req.body || {});
    res.status(status).json(body);
  } catch (err) {
    logger.error('Receipt upload failed', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// ── Phone pairing ───────────────────────────────────────────────────────────
function captureUrl(req, token) { return `${req.protocol}://${req.get('host')}/capture/${token}`; }

router.post('/pair', requireAuth, async (req, res) => {
  try {
    const token = pairing.create(req.user.id, { reportId: (req.body || {}).reportId || null });
    const url   = captureUrl(req, token);
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' });
    res.status(201).json({ token, url, qrSvg, expiresInMs: pairing.TTL_MS, maxUploads: pairing.MAX_USES });
  } catch (err) {
    res.status(500).json({ error: 'Could not create a pairing code' });
  }
});

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
router.get('/capture/:token', (req, res) => {
  const state = pairing.verify(req.params.token);
  if (!state) return res.status(401).json({ ok: false, ...EXPIRED });
  let openCase = null;
  if (state.reportId) {
    const r = require('../store/reports').getReport(state.reportId);
    if (r) openCase = { id: r.id, number: r.number, title: r.title || null };
  }
  res.json({ ok: true, usesLeft: state.usesLeft, expiresInMs: state.expiresInMs, reportId: state.reportId || null, case: openCase });
});
router.get('/capture/:token/status', (req, res) => {
  const state = pairing.verify(req.params.token);
  if (!state) return res.status(401).json(EXPIRED);
  res.json({ ok: true, usesLeft: state.usesLeft, expiresInMs: state.expiresInMs, reportId: state.reportId || null,
             receipts: _phoneView(state.receiptIds, false) });
});
router.post('/capture/:token', (req, res) => {
  const state = pairing.verify(req.params.token);
  if (!state) return res.status(401).json(EXPIRED);
  try {
    const me = users.findById(state.userId);
    if (!me) return res.status(401).json(EXPIRED);
    const { status, body } = storeReceipt(me, { ...(req.body || {}), source: 'phone', reportId: state.reportId || null });
    if (status === 201) pairing.consume(req.params.token, body.receipt.id);
    if (body.imageToken) delete body.imageToken;
    res.status(status).json(body);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// ── Images ──────────────────────────────────────────────────────────────────
// Company-wide used to be enough here, which meant any colleague holding a
// receipt id could mint a token and read the file. The duplicate-upload reply
// hands out exactly that id ("already uploaded by a colleague"), so it was
// reachable. Same rule as every other read: yourself, your reports, or finance.
router.get('/:id/token', requireAuth, (req, res) => {
  const r = store.getReceipt(req.params.id);
  const me = users.findById(req.user.id);
  if (!r || r.companyId !== me.companyId || !canAccessUser(req.user, r.userId)) return res.status(404).json({ error: 'Receipt not found' });
  res.json({ token: issueImageToken(r.userId, r.id) });
});

router.get('/:id/image', asyncHandler(async (req, res) => {
  let payload;
  try { payload = verifyImageToken(req.query.token, req.params.id); }
  catch { return res.status(401).json({ error: 'Invalid or expired image token' }); }
  const r = store.getReceipt(req.params.id);
  if (!r) return res.status(404).json({ error: 'Receipt not found' });
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
module.exports.checkCase = checkCase;
module.exports.issueImageToken = issueImageToken;
module.exports._drain = async function _drain() { while (_inflight.size) await Promise.allSettled([..._inflight]); };
