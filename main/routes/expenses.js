const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { canView, isOwner } = require('../middleware/roles');
const users   = require('../store/users');
const store   = require('../store/expenses');
const receiptStore = require('../receipts/receipt-store');
const { issueImageToken } = require('./receipts');
const { readOne, applyRead, flagIfSuspected, withoutCurrencyNote } = require('../receipts/read-receipt');
const { applyFx, overrideFx } = require('../fx/apply');
const wf      = require('../reports/workflow');
const { isLocked } = wf;
const reports = require('../store/reports');
const asyncHandler = require('../middleware/async-handler');
const { canonicalCategory } = require('../intake/categories');
const logger  = require('../utils/logger');

// An expense is one claimable receipt after reading. A user works on their
// own; an admin sees the company.
// reportId is deliberately NOT here. It used to be, and it was passed straight
// to the store, so filing an expense obeyed none of the rules the case route
// enforces: a user could attach an unchecked receipt to a case that had
// already been claimed — or to a colleague's case — and change a total that
// had been put through. Filing now goes through _file() below, which asks the
// same questions POST /api/reports/:id/expenses asks. An unknown id also used
// to reach SQLite as a foreign-key violation inside an unwrapped async
// handler, which took the whole server down with it.
const EDITABLE = ['merchant', 'receiptDate', 'receiptTime', 'invoiceNo', 'currency', 'total', 'tax', 'subTotal', 'purpose', 'description', 'category'];

// Seeing a receipt: its owner, or an admin of the same company monitoring.
function _load(req, res) {
  const e = store.getExpense(req.params.id);
  if (!e || !canView(req.user, e.userId, e.companyId)) { res.status(404).json({ error: 'Expense not found' }); return null; }
  return e;
}
const LOCKED = 'This receipt is in a case that has been claimed. Reopen the case to change it.';
const NOT_YOURS = 'Only the person who claimed this receipt can change it.';
// Changing it: the owner only. An admin's view of somebody else's claim is
// for monitoring; the claim stays the claimant's.
function _loadEditable(req, res) {
  const e = _load(req, res);
  if (!e) return null;
  if (!isOwner(req.user, e.userId, e.companyId)) { res.status(403).json({ error: NOT_YOURS }); return null; }
  if (isLocked(e)) { res.status(409).json({ error: LOCKED }); return null; }
  return e;
}
// Moving an expense into or out of a report. Both ends have to be open: you
// cannot take an expense out of a report that has been submitted, and you
// cannot put one into a report that is not the owner's own draft.
function _file(e, reportId, actor) {
  const fail = (status, error) => { const err = new Error(error); err.status = status; throw err; };
  const leaving = () => {
    if (!e.reportId) return;
    const cur = reports.getReport(e.reportId);
    if (cur && !wf.isEditable(cur)) fail(409, `A ${cur.status} case cannot be changed`);
    reports.removeExpense(e.reportId, e.id);
  };
  if (!reportId) { leaving(); return; }
  if (reportId === e.reportId) return;
  const r = reports.getReport(reportId);
  if (!r || r.companyId !== e.companyId) fail(404, 'Case not found');
  if (r.userId !== e.userId || r.userId !== actor.id) fail(403, 'That case belongs to someone else');
  if (!wf.isEditable(r)) fail(409, `A ${r.status} case cannot take more receipts`);
  leaving();
  reports.addExpense(r.id, e.id);
}

function _out(e) { return { expense: e, locked: isLocked(e), imageToken: e.receipt ? issueImageToken(e.receipt.userId, e.receipt.id) : null }; }

router.get('/', requireAuth, (req, res) => {
  const wide = req.query.all === '1' && req.user.role === 'admin';
  const filter = { status: req.query.status || undefined, reportId: req.query.reportId || undefined, unfiled: req.query.unfiled === '1',
                   from: req.query.from || undefined, to: req.query.to || undefined };
  let list;
  if (wide) list = store.listExpenses({ companyId: req.user.companyId, userId: req.query.userId || undefined, ...filter });
  else if (req.query.userId && req.query.userId !== req.user.id) {
    const owner = users.findById(req.query.userId);
    if (!owner || !canView(req.user, owner.id, owner.companyId)) return res.status(404).json({ error: 'Not found' });
    list = store.listExpenses({ userId: owner.id, ...filter });
  } else list = store.listExpenses({ userId: req.user.id, ...filter });
  res.json({ expenses: list });
});

router.get('/:id', requireAuth, (req, res) => { const e = _load(req, res); if (e) res.json(_out(e)); });

router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const e = _loadEditable(req, res); if (!e) return;
  if (e.status === 'duplicate') return res.status(400).json({ error: 'A duplicate cannot be edited; delete it or restore it first' });
  const b = req.body || {}, patch = {};
  for (const k of EDITABLE) if (b[k] !== undefined) patch[k] = b[k] === '' ? null : b[k];
  if (patch.currency && !/^[A-Z]{3}$/.test(String(patch.currency))) return res.status(400).json({ error: 'Currency must be a 3-letter code like SGD or INR' });
  if (patch.receiptDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(patch.receiptDate))) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  for (const k of ['total', 'tax', 'subTotal']) if (patch[k] !== undefined && patch[k] !== null && !(Number(patch[k]) >= 0)) return res.status(400).json({ error: `${k} must be a number` });
  if (patch.category !== undefined && patch.category !== null && !canonicalCategory(patch.category)) return res.status(400).json({ error: 'Unknown category' });
  if (patch.category) patch.category = canonicalCategory(patch.category);
  if (b.reportId !== undefined) {
    try { _file(e, b.reportId || null, req.user); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  }
  // Setting the currency answers the reader's note that it was assumed.
  const currencyChanged = patch.currency !== undefined && patch.currency !== e.currency;
  if (currencyChanged && e.errorMsg) patch.errorMsg = withoutCurrencyNote(e.errorMsg);
  const updated = store.updateExpense(e.id, patch);
  // A single line follows the total; a split is the claimant's to redo.
  if (patch.total !== undefined && updated.lines.length === 1) {
    store.replaceLines(e.id, [{ ...updated.lines[0], amount: updated.total, currency: updated.currency }]);
  } else if (patch.currency && updated.lines.length) {
    store.replaceLines(e.id, updated.lines.map(l => ({ ...l, currency: updated.currency })), { force: true });
  }
  // A new currency, date or amount changes what the base figure is. A rate
  // somebody typed was typed for the OLD currency, so a currency change drops
  // it and fetches afresh; a new date or total keeps it (it is their decision,
  // and the base amount follows the line).
  if (patch.currency !== undefined || patch.receiptDate !== undefined || patch.total !== undefined) await applyFx(e.id, { force: currencyChanged });
  res.json(_out(store.getExpense(e.id)));
}));

router.put('/:id/lines', requireAuth, asyncHandler(async (req, res) => {
  const e = _loadEditable(req, res); if (!e) return;
  const lines = Array.isArray((req.body || {}).lines) ? req.body.lines : null;
  if (!lines || !lines.length) return res.status(400).json({ error: 'Send at least one line' });
  for (const l of lines) {
    if (!(Number(l.amount) > 0)) return res.status(400).json({ error: 'Every line needs an amount above zero' });
    if (l.category && !canonicalCategory(l.category)) return res.status(400).json({ error: `Unknown category "${l.category}"` });
  }
  try {
    store.replaceLines(e.id, lines.map(l => ({ category: canonicalCategory(l.category) || e.category || 'Other', description: l.description || null, amount: Number(l.amount), onBehalfOf: l.onBehalfOf || null, currency: e.currency })));
  } catch (err) { return res.status(400).json({ error: err.message }); }
  await applyFx(e.id);
  res.json(_out(store.getExpense(e.id)));
}));

// Refresh from the provider, dropping any typed rate.
router.post('/:id/fx', requireAuth, asyncHandler(async (req, res) => {
  const e = _loadEditable(req, res); if (!e) return;
  const out = await applyFx(e.id, { force: true });
  res.json({ ...out, ...(_out(store.getExpense(e.id))) });
}));

// The claimant or finance types a rate, with a reason.
router.patch('/:id/fx', requireAuth, asyncHandler(async (req, res) => {
  const e = _loadEditable(req, res); if (!e) return;
  try {
    const updated = await overrideFx(e.id, { rate: (req.body || {}).rate, reason: (req.body || {}).reason, actor: req.user });
    res.json(_out(updated));
  } catch (err) { res.status(400).json({ error: err.message }); }
}));

router.patch('/:id/status', requireAuth, (req, res) => {
  const e = _loadEditable(req, res); if (!e) return;
  const status = (req.body || {}).status;
  if (!['reviewed', 'review-needed'].includes(status)) return res.status(400).json({ error: 'Status can be reviewed or review-needed here' });
  if (status === 'reviewed') {
    const missing = [];
    if (!e.merchant) missing.push('merchant');
    if (!e.receiptDate) missing.push('date');
    if (!e.currency) missing.push('currency');
    if (!(e.total > 0)) missing.push('total');
    if (missing.length) return res.status(400).json({ error: `Fill in the ${missing.join(', ')} before marking this reviewed` });
    if (!store.linesReconcile(e.lines, store.toCents(e.total))) return res.status(400).json({ error: 'The lines do not add up to the receipt total' });
  }
  const patch = { status };
  // Marking it reviewed is the person saying the currency on it is right.
  if (status === 'reviewed' && e.errorMsg) patch.errorMsg = withoutCurrencyNote(e.errorMsg);
  res.json(_out(store.updateExpense(e.id, patch)));
});

// POST /:id/claimed — the owner's own record that this one receipt has been put
// through, for a one-off claimed outside any report. DELETE takes it back.
// Claiming the report it sits in claims it too; see reports/workflow.js.
router.post('/:id/claimed', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  try { res.json(_out(wf.markExpenseClaimed(e.id, req.user, true))); }
  catch (err) { res.status(/Only the claimant/.test(err.message) ? 403 : 400).json({ error: err.message }); }
});
router.delete('/:id/claimed', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  try { res.json(_out(wf.markExpenseClaimed(e.id, req.user, false))); }
  catch (err) { res.status(/Only the claimant/.test(err.message) ? 403 : 400).json({ error: err.message }); }
});

router.post('/:id/reread', requireAuth, asyncHandler(async (req, res) => {
  const e = _loadEditable(req, res); if (!e) return;
  if (!e.receipt) return res.status(400).json({ error: 'This expense has no receipt file to read' });
  const buffer = receiptStore.forUser(e.receipt.userId).read(e.receipt.file);
  if (!buffer) return res.status(404).json({ error: 'The receipt file is missing from storage' });
  try {
    const r = await readOne(e.userId, buffer, e.receipt.mime, { page: e.page, box: e.box });
    if (!r) return res.json({ ok: false, reason: 'unreadable', expense: e });
    await applyRead(e.id, r); flagIfSuspected(e.id);
    res.json({ ok: true, ...(_out(store.getExpense(e.id))), confidence: r.confidence });
  } catch (err) {
    logger.warn('Re-read failed', { id: e.id, error: err.message });
    res.json({ ok: false, reason: 'unavailable', expense: e });
  }
}));

router.get('/:id/group', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  if (!e.receiptId) return res.json({ split: false, index: 1, total: 1, siblings: [] });
  const members = store.expensesForReceipt(e.receiptId).sort((a, b) => (a.page || 0) - (b.page || 0) || String(a.id).localeCompare(String(b.id)));
  const groupId = e.receipt && e.receipt.groupId;
  const batch = groupId ? store.listExpenses({ groupId }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) : null;
  const list = batch && batch.length > 1 ? batch : members;
  res.json({
    split: list.length > 1, groupType: batch && batch.length > 1 ? 'batch' : 'split',
    index: list.findIndex(x => x.id === e.id) + 1, total: list.length,
    siblings: list.map(x => ({ id: x.id, merchant: x.merchant, total: x.total, currency: x.currency, page: x.page, status: x.status })),
  });
});

router.post('/:id/merge', requireAuth, (req, res) => {
  const e = _loadEditable(req, res); if (!e) return;
  if (!e.receiptId) return res.status(400).json({ error: 'This expense was not split' });
  const siblings = store.expensesForReceipt(e.receiptId).filter(x => x.id !== e.id);
  if (!siblings.length) return res.status(400).json({ error: 'This expense was not split' });
  // Merging deletes the siblings, so each must be one this person could delete
  // on its own: theirs, and not in a claimed case. One sitting in a claimed
  // case used to vanish from it, changing a total that had been put through.
  if (siblings.some(x => x.userId !== e.userId || isLocked(x))) return res.status(409).json({ error: 'Part of this receipt is in a claimed case. Reopen that case first.' });
  if (siblings.some(x => (x.reportId || null) !== (e.reportId || null))) return res.status(409).json({ error: 'The parts of this receipt are in different cases. Move them into one case first.' });
  for (const s of siblings) store.deleteExpense(s.id);
  res.json(_out(store.updateExpense(e.id, { box: null, page: null })));
});

router.delete('/:id', requireAuth, (req, res) => {
  const e = _loadEditable(req, res); if (!e) return;
  store.deleteExpense(e.id);
  if (e.receipt && store.countExpensesForReceipt(e.receipt.id) === 0) {
    if (store.countExpensesForFile(e.receipt.userId, e.receipt.file) === 0) receiptStore.forUser(e.receipt.userId).remove(e.receipt.file);
    store.deleteReceipt(e.receipt.id);
  }
  logger.info('Expense deleted', { id: e.id, by: req.user.id });
  res.json({ ok: true });
});

module.exports = router;
