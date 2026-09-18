const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { canAccessUser } = require('../middleware/roles');
const users   = require('../utils/users');
const store   = require('../store/expenses');
const receiptStore = require('../utils/receipt-store');
const { issueImageToken } = require('./receipts');
const { readOne, applyRead, flagIfSuspected } = require('../receipts/read-receipt');
const { applyFx, overrideFx } = require('../fx/apply');
const { isLocked } = require('../reports/workflow');
const { canonicalCategory } = require('../claims/categories');
const logger  = require('../utils/logger');

// An expense is one claimable receipt after reading. Employees work on their
// own; a manager sees direct reports; finance and admin see the company.
const EDITABLE = ['merchant', 'receiptDate', 'receiptTime', 'invoiceNo', 'currency', 'total', 'tax', 'subTotal', 'purpose', 'description', 'category', 'reportId'];

function _load(req, res) {
  const e = store.getExpense(req.params.id);
  if (!e || !canAccessUser(req.user, e.userId)) { res.status(404).json({ error: 'Expense not found' }); return null; }
  return e;
}
const LOCKED = 'This expense is in a report that has been submitted. Ask for it to be rejected to change it.';
function _loadEditable(req, res) {
  const e = _load(req, res);
  if (e && isLocked(e)) { res.status(409).json({ error: LOCKED }); return null; }
  return e;
}
function _out(e) { return { expense: e, locked: isLocked(e), imageToken: e.receipt ? issueImageToken(e.receipt.userId, e.receipt.id) : null }; }

router.get('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  const wide = req.query.all === '1' && (req.user.role === 'finance' || req.user.role === 'admin');
  const filter = { status: req.query.status || undefined, reportId: req.query.reportId || undefined, unfiled: req.query.unfiled === '1',
                   from: req.query.from || undefined, to: req.query.to || undefined };
  let list;
  if (wide) list = store.listExpenses({ companyId: me.companyId, userId: req.query.userId || undefined, ...filter });
  else if (req.query.userId && req.query.userId !== req.user.id) {
    if (!canAccessUser(req.user, req.query.userId)) return res.status(403).json({ error: 'Not your report' });
    list = store.listExpenses({ userId: req.query.userId, ...filter });
  } else list = store.listExpenses({ userId: req.user.id, ...filter });
  res.json({ expenses: list });
});

router.get('/:id', requireAuth, (req, res) => { const e = _load(req, res); if (e) res.json(_out(e)); });

router.patch('/:id', requireAuth, async (req, res) => {
  const e = _loadEditable(req, res); if (!e) return;
  if (e.status === 'duplicate') return res.status(400).json({ error: 'A duplicate cannot be edited; delete it or restore it first' });
  const b = req.body || {}, patch = {};
  for (const k of EDITABLE) if (b[k] !== undefined) patch[k] = b[k] === '' ? null : b[k];
  if (patch.currency && !/^[A-Z]{3}$/.test(String(patch.currency))) return res.status(400).json({ error: 'Currency must be a 3-letter code like SGD or INR' });
  if (patch.receiptDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(patch.receiptDate))) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  for (const k of ['total', 'tax', 'subTotal']) if (patch[k] !== undefined && patch[k] !== null && !(Number(patch[k]) >= 0)) return res.status(400).json({ error: `${k} must be a number` });
  if (patch.category !== undefined && patch.category !== null && !canonicalCategory(patch.category)) return res.status(400).json({ error: 'Unknown category' });
  if (patch.category) patch.category = canonicalCategory(patch.category);
  const updated = store.updateExpense(e.id, patch);
  // A single line follows the total; a split is the claimant's to redo.
  if (patch.total !== undefined && updated.lines.length === 1) {
    store.replaceLines(e.id, [{ ...updated.lines[0], amount: updated.total, currency: updated.currency }]);
  } else if (patch.currency && updated.lines.length) {
    store.replaceLines(e.id, updated.lines.map(l => ({ ...l, currency: updated.currency })), { force: true });
  }
  // A new currency, date or amount changes what the base figure is.
  if (patch.currency !== undefined || patch.receiptDate !== undefined || patch.total !== undefined) await applyFx(e.id);
  res.json(_out(store.getExpense(e.id)));
});

router.put('/:id/lines', requireAuth, async (req, res) => {
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
});

// Refresh from the provider, dropping any typed rate.
router.post('/:id/fx', requireAuth, async (req, res) => {
  const e = _loadEditable(req, res); if (!e) return;
  const out = await applyFx(e.id, { force: true });
  res.json({ ...out, ...(_out(store.getExpense(e.id))) });
});

// The claimant or finance types a rate, with a reason.
router.patch('/:id/fx', requireAuth, async (req, res) => {
  const e = _loadEditable(req, res); if (!e) return;
  try {
    const updated = await overrideFx(e.id, { rate: (req.body || {}).rate, reason: (req.body || {}).reason, actor: req.user });
    res.json(_out(updated));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

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
  res.json(_out(store.updateExpense(e.id, { status })));
});

router.post('/:id/reread', requireAuth, async (req, res) => {
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
});

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
  logger.info('Expense deleted', { id: e.id, by: req.user.email });
  res.json({ ok: true });
});

module.exports = router;
