const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { canView, isOwner } = require('../middleware/roles');
const users   = require('../store/users');
const store   = require('../store/expenses');
const changes = require('../store/changes');
const edit    = require('../receipts/edit');
const receiptStore = require('../receipts/receipt-store');
const { issueImageToken } = require('./receipts');
const { readOne, applyRead, flagIfSuspected, withoutCurrencyNote } = require('../receipts/read-receipt');
const wf      = require('../reports/workflow');
const { isLocked } = wf;
const reports = require('../store/reports');
const asyncHandler = require('../middleware/async-handler');
const logger  = require('../utils/logger');

// An expense is one claimable receipt after reading. Two kinds of change, two
// rules (receipts/edit.js says it at length):
//
//   details   merchant, date, amounts, category, lines, rate. The owner or an
//             admin of the same company, open or claimed, until the case is
//             in Xero. Every change is logged. They go through receipts/edit.js,
//             which the assistant uses too, so both doors obey one rule.
//   actions   filing, marking checked, claiming, re-reading, merging,
//             deleting. The owner's alone, and only while the case is open.
//
// Filing is an action, not a detail. reportId used to be passed straight to
// the store, so filing obeyed none of the rules the case route enforces; it
// now goes through _file(), which asks the questions POST
// /api/reports/:id/expenses asks.

// Seeing a receipt: its owner, or an admin of the same company monitoring.
function _load(req, res) {
  const e = store.getExpense(req.params.id);
  if (!e || !canView(req.user, e.userId, e.companyId)) { res.status(404).json({ error: 'Expense not found' }); return null; }
  return e;
}
const LOCKED = 'This receipt is in a case that has been claimed. Reopen the case to change it.';
const NOT_YOURS = 'Only the person who claimed this receipt can do that.';
function _actionBlocked(e, actor) {
  if (!isOwner(actor, e.userId, e.companyId)) return { status: 403, error: NOT_YOURS };
  if (isLocked(e)) return { status: 409, error: LOCKED };
  return null;
}
// Acting on it: the owner, while the case is open.
function _loadActionable(req, res) {
  const e = _load(req, res);
  if (!e) return null;
  const blocked = _actionBlocked(e, req.user);
  if (blocked) { res.status(blocked.status).json({ error: blocked.error }); return null; }
  return e;
}
// Moving an expense into or out of a report. Both ends have to be open: you
// cannot take an expense out of a report that has been claimed, and you
// cannot put one into a report that is not the owner's own open case.
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

// The expense, and what the person looking at it may do with it.
function _out(e, req) {
  return { expense: e, locked: isLocked(e), ...edit.permissions(e, req.user),
           imageToken: e.receipt ? issueImageToken(e.receipt.userId, e.receipt.id) : null };
}
// An error thrown with a status is an answer; anything else is a fault.
function _answer(res, err) {
  if (!err.status) throw err;
  res.status(err.status).json({ error: err.message });
}

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

router.get('/:id', requireAuth, (req, res) => { const e = _load(req, res); if (e) res.json(_out(e, req)); });

// Who changed what on this receipt, newest first, and what the reader first
// read off it.
router.get('/:id/changes', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  res.json({ changes: changes.list(e.id), aiRead: e.aiRead || null });
});

// Details, and optionally filing it into a case. Filing is only looked at
// when it actually moves the receipt, so a page may send the case it is
// already in alongside a detail edit.
router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const e = _load(req, res); if (!e) return;
  const b = req.body || {};
  const filing = b.reportId !== undefined && (b.reportId || null) !== (e.reportId || null);
  try {
    const patch = edit.cleanPatch(b);
    const hasDetails = Object.keys(patch).length > 0;
    if (hasDetails) {
      const blocked = edit.detailsBlocked(e, req.user);
      if (blocked) return res.status(blocked.status).json({ error: blocked.error });
    }
    if (filing) {
      const blocked = _actionBlocked(e, req.user);
      if (blocked) return res.status(blocked.status).json({ error: blocked.error });
      if (e.status === 'duplicate') return res.status(400).json({ error: 'A duplicate cannot be filed; delete it or restore it first' });
      _file(e, b.reportId || null, req.user);
    }
    const out = hasDetails ? await edit.editDetails(e.id, b, req.user) : store.getExpense(e.id);
    res.json(_out(out, req));
  } catch (err) { _answer(res, err); }
}));

router.put('/:id/lines', requireAuth, asyncHandler(async (req, res) => {
  const e = _load(req, res); if (!e) return;
  try { res.json(_out(await edit.editLines(e.id, (req.body || {}).lines, req.user), req)); }
  catch (err) { _answer(res, err); }
}));

// Refresh from the provider, dropping any typed rate.
router.post('/:id/fx', requireAuth, asyncHandler(async (req, res) => {
  const e = _load(req, res); if (!e) return;
  try {
    const { expense, ...out } = await edit.refreshRate(e.id, req.user);
    res.json({ ...out, ..._out(expense, req) });
  } catch (err) { _answer(res, err); }
}));

// A typed rate, with a reason.
router.patch('/:id/fx', requireAuth, asyncHandler(async (req, res) => {
  const e = _load(req, res); if (!e) return;
  const b = req.body || {};
  try { res.json(_out(await edit.setRate(e.id, { rate: b.rate, reason: b.reason }, req.user), req)); }
  catch (err) { _answer(res, err); }
}));

router.patch('/:id/status', requireAuth, (req, res) => {
  const e = _loadActionable(req, res); if (!e) return;
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
  res.json(_out(store.updateExpense(e.id, patch), req));
});

// POST /:id/claimed — the owner's own record that this one receipt has been put
// through, for a one-off claimed outside any report. DELETE takes it back.
// Claiming the report it sits in claims it too; see reports/workflow.js.
router.post('/:id/claimed', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  try { res.json(_out(wf.markExpenseClaimed(e.id, req.user, true), req)); }
  catch (err) { res.status(/Only the claimant/.test(err.message) ? 403 : 400).json({ error: err.message }); }
});
router.delete('/:id/claimed', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  try { res.json(_out(wf.markExpenseClaimed(e.id, req.user, false), req)); }
  catch (err) { res.status(/Only the claimant/.test(err.message) ? 403 : 400).json({ error: err.message }); }
});

// Reading the receipt again replaces what is on it, so what changed is logged
// like any other edit, marked as the reader's.
router.post('/:id/reread', requireAuth, asyncHandler(async (req, res) => {
  const e = _loadActionable(req, res); if (!e) return;
  if (!e.receipt) return res.status(400).json({ error: 'This expense has no receipt file to read' });
  const buffer = receiptStore.forUser(e.receipt.userId).read(e.receipt.file);
  if (!buffer) return res.status(404).json({ error: 'The receipt file is missing from storage' });
  try {
    const r = await readOne(e.userId, buffer, e.receipt.mime, { page: e.page, box: e.box });
    if (!r) return res.json({ ok: false, reason: 'unreadable', expense: e });
    await applyRead(e.id, r); flagIfSuspected(e.id);
    const after = store.getExpense(e.id);
    changes.record(e, after, req.user, 'reread');
    res.json({ ok: true, ..._out(after, req), confidence: r.confidence });
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
  const e = _loadActionable(req, res); if (!e) return;
  if (!e.receiptId) return res.status(400).json({ error: 'This expense was not split' });
  const siblings = store.expensesForReceipt(e.receiptId).filter(x => x.id !== e.id);
  if (!siblings.length) return res.status(400).json({ error: 'This expense was not split' });
  // Merging deletes the siblings, so each must be one this person could delete
  // on its own: theirs, and not in a claimed case. One sitting in a claimed
  // case used to vanish from it, changing a total that had been put through.
  if (siblings.some(x => x.userId !== e.userId || isLocked(x))) return res.status(409).json({ error: 'Part of this receipt is in a claimed case. Reopen that case first.' });
  if (siblings.some(x => (x.reportId || null) !== (e.reportId || null))) return res.status(409).json({ error: 'The parts of this receipt are in different cases. Move them into one case first.' });
  for (const s of siblings) store.deleteExpense(s.id);
  res.json(_out(store.updateExpense(e.id, { box: null, page: null }), req));
});

router.delete('/:id', requireAuth, (req, res) => {
  const e = _loadActionable(req, res); if (!e) return;
  store.deleteExpense(e.id);
  if (e.receipt && store.countExpensesForReceipt(e.receipt.id) === 0) {
    if (store.countExpensesForFile(e.receipt.userId, e.receipt.file) === 0) receiptStore.forUser(e.receipt.userId).remove(e.receipt.file);
    store.deleteReceipt(e.receipt.id);
  }
  logger.info('Expense deleted', { id: e.id, by: req.user.id });
  res.json({ ok: true });
});

module.exports = router;
