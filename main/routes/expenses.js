const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { canView } = require('../middleware/roles');
const users   = require('../store/users');
const store   = require('../store/expenses');
const changes = require('../store/changes');
const edit    = require('../receipts/edit');
const receiptStore = require('../receipts/receipt-store');
const { issueImageToken } = require('./receipts');
const { readOne, applyRead, flagIfSuspected } = require('../receipts/read-receipt');
const wf      = require('../reports/workflow');
const { isLocked } = wf;
const { flagsFor } = require('../receipts/flags');
const { localDate } = require('../utils/zone-date');
const db      = require('../db');
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
// now goes through edit.fileInCase(), which asks the questions POST
// /api/reports/:id/expenses asks.

// Seeing a receipt: its owner, or an admin of the same company monitoring.
function _load(req, res) {
  const e = store.getExpense(req.params.id);
  if (!e || !canView(req.user, e.userId, e.companyId)) { res.status(404).json({ error: 'Expense not found' }); return null; }
  return e;
}
// Acting on it: the owner, while the case is open.
function _loadActionable(req, res) {
  const e = _load(req, res);
  if (!e) return null;
  const blocked = edit.actionBlocked(e, req.user);
  if (blocked) { res.status(blocked.status).json({ error: blocked.error }); return null; }
  return e;
}

// The company's currency and day, for the flags (receipts/flags.js): "in the
// future" is the company's today, not the server's UTC one.
function _flagOptions(companyId) {
  const c = users.getCompany(companyId) || {};
  return { baseCurrency: c.baseCurrency || 'SGD', today: localDate(c.timezone || 'Asia/Singapore') };
}
// The cases a list of receipts sits in, in one query however many there are:
// asking per receipt was a query each, on a page that lists hundreds.
function _casesOf(list) {
  const ids = [...new Set(list.map(e => e.reportId).filter(Boolean))];
  if (!ids.length) return new Map();
  return new Map(db.prepare('SELECT id, number, title, status, period_from, period_to FROM expense_reports WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)).map(r => [r.id, { number: r.number, title: r.title, status: r.status, periodFrom: r.period_from, periodTo: r.period_to }]));
}

// The expense, what is worth a look on it, and what the person looking at it
// may do with it.
function _out(e, req) {
  const flags = flagsFor(e, _casesOf([e]).get(e.reportId) || null, _flagOptions(e.companyId));
  return { expense: { ...e, flags }, locked: isLocked(e), ...edit.permissions(e, req.user),
           imageToken: e.receipt ? issueImageToken(e.receipt.userId, e.receipt.id, req.user.id) : null };
}
// An error thrown with a status is an answer; anything else is a fault.
function _answer(res, err) {
  if (!err.status) throw err;
  res.status(err.status).json({ error: err.message });
}

// ?q= finds a receipt by what is printed on it: the merchant, the
// description or the invoice number, any part, any case.
const Q_MAX = 100;
function _matches(e, q) {
  return [e.merchant, e.description, e.invoiceNo].some(v => v && String(v).toLowerCase().includes(q));
}

router.get('/', requireAuth, (req, res) => {
  if (req.query.q !== undefined && typeof req.query.q !== 'string') return res.status(400).json({ error: 'q must be text' });
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
  const q = String(req.query.q || '').trim().slice(0, Q_MAX).toLowerCase();
  if (q) list = list.filter(e => _matches(e, q));
  // Each row says which case it is in and what is worth a look on it, so
  // the list can show both without asking again for every row.
  const cases = _casesOf(list);
  const opts = _flagOptions(req.user.companyId);
  res.json({ expenses: list.map(e => {
    const c = cases.get(e.reportId) || null;
    return { ...e, reportNumber: c ? c.number : null, reportTitle: c ? c.title : null, reportStatus: c ? c.status : null, flags: flagsFor(e, c, opts) };
  }) });
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
    if (filing) edit.fileInCase(e.id, b.reportId || null, req.user);
    const out = hasDetails ? await edit.editDetails(e.id, b, req.user) : store.getExpense(e.id);
    res.json(_out(out, req));
  } catch (err) { _answer(res, err); }
}));

// The lines of a receipt with no record (one read before receipts were kept
// as printed, or typed in). A receipt with one answers 409: its lines are
// made from its rows.
router.put('/:id/lines', requireAuth, asyncHandler(async (req, res) => {
  const e = _load(req, res); if (!e) return;
  try { res.json(_out(await edit.editLines(e.id, (req.body || {}).lines, req.user), req)); }
  catch (err) { _answer(res, err); }
}));

// The receipt as printed, { printed: { v, rows, subtotal, total } }, typed
// over. The same people may as for the details; the total, tax and subtotal
// and the lines follow it (receipts/edit.js editPrinted), and the answer is
// the expense as GET gives it.
router.put('/:id/printed', requireAuth, asyncHandler(async (req, res) => {
  const e = _load(req, res); if (!e) return;
  try { res.json(_out(await edit.editPrinted(e.id, (req.body || {}).printed, req.user), req)); }
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
  const e = _load(req, res); if (!e) return;
  try { res.json(_out(edit.setStatus(e.id, (req.body || {}).status, req.user), req)); }
  catch (err) { _answer(res, err); }
});

// POST /:id/claimed — the owner's own record that this one receipt has been put
// through, for a one-off claimed outside any report. DELETE takes it back.
// Claiming the report it sits in claims it too; see reports/workflow.js.
router.post('/:id/claimed', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  try { res.json(_out(wf.markExpenseClaimed(e.id, req.user, true), req)); }
  catch (err) { _answer(res, err); }
});
// Taken back, it is priced as any open receipt is: a live rate whose day has
// closed since moves to the close (fx/apply.js reprice).
router.delete('/:id/claimed', requireAuth, asyncHandler(async (req, res) => {
  const e = _load(req, res); if (!e) return;
  try { wf.markExpenseClaimed(e.id, req.user, false); }
  catch (err) { return _answer(res, err); }
  await require('../fx/apply').reprice([e.id]);
  res.json(_out(store.getExpense(e.id), req));
}));

// Reading the receipt again replaces what is on it, so what changed is logged
// like any other edit, marked as the reader's.
router.post('/:id/reread', requireAuth, asyncHandler(async (req, res) => {
  const e = _loadActionable(req, res); if (!e) return;
  if (!e.receipt) return res.status(400).json({ error: 'This expense has no receipt file to read' });
  const buffer = receiptStore.forUser(e.receipt.userId).read(e.receipt.file);
  if (!buffer) return res.status(404).json({ error: 'The receipt file is missing from storage' });
  try {
    const r = await readOne(e.userId, buffer, e.receipt.mime, { page: e.page, box: e.box });
    if (!r) {
      // A row left 'reading' by an interrupted read is released either way.
      if (e.status === 'reading') store.updateExpense(e.id, { status: 'review-needed' });
      return res.json({ ok: false, reason: 'unreadable', expense: store.getExpense(e.id) });
    }
    await applyRead(e.id, r, { reread: true }); flagIfSuspected(e.id);
    if (store.getExpense(e.id).status === 'reading') store.updateExpense(e.id, { status: 'review-needed' });
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
  // The batch is the owner's own: a group id alone is not a permission.
  const batch = groupId ? store.listExpenses({ groupId, userId: e.userId }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) : null;
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
  // The parts go and the whole stays, together. What this part printed is no
  // longer the whole receipt's record, so it is not kept; the lines stay as
  // they were, and are the claimant's to change from here.
  const merged = require('../db').transaction(() => {
    for (const s of siblings) store.deleteExpense(s.id);
    return store.updateExpense(e.id, { box: null, page: null, printed: null });
  })();
  changes.record(e, merged, req.user);
  res.json(_out(merged, req));
});

// A receipt deleted from a case is named in the case's history: its own log
// goes with it, and the case would otherwise have nothing to show it was ever
// there.
router.delete('/:id', requireAuth, (req, res) => {
  const e = _loadActionable(req, res); if (!e) return;
  require('../receipts/remove').removeExpense(e);
  const reports = require('../store/reports');
  if (e.reportId && reports.head(e.reportId)) reports.addEvent(e.reportId, req.user.id, 'deleted', changes.receiptName(e));
  logger.info('Expense deleted', { id: e.id, by: req.user.id });
  res.json({ ok: true });
});

module.exports = router;
