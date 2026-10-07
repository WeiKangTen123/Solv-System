const store   = require('../store/expenses');
const changes = require('../store/changes');
const wf      = require('../reports/workflow');
const { canEditDetails, isOwner } = require('../middleware/roles');
const { canonicalCategory } = require('../intake/categories');
const { applyFx, overrideFx } = require('../fx/apply');
const { withoutCurrencyNote } = require('./read-receipt');

// Changing a receipt: the one way it is done, by a person on the page or by
// the assistant on their behalf. Every function here checks who may, applies
// the change, and writes what changed to the receipt's change log.
//
// Two kinds of change, two rules:
//
//   details   merchant, date, invoice number, currency, amounts, category,
//             purpose, the lines and the exchange rate. The owner, or an admin
//             of the same company checking it. Allowed while the case is open
//             and after it is claimed — every change is logged and, after a
//             claim, written to the case's history too — and never once the
//             case is in Xero, where the bill already exists.
//   actions   filing, marking checked, claiming, re-reading, deleting. The
//             owner's alone, and only while the case is open. Filing and
//             marking reviewed are below, for the assistant to share; the rest
//             live in routes/expenses.js and reports/workflow.js.
//
// Errors carry an HTTP status, so a route can answer with it as it stands.

const EDITABLE = ['merchant', 'receiptDate', 'receiptTime', 'invoiceNo', 'currency', 'total', 'tax', 'subTotal', 'purpose', 'description', 'category'];
const MAX_TEXT = { merchant: 120, invoiceNo: 60, purpose: 300, description: 300, receiptTime: 8 };
// Above this a number is a typing slip or an attack, not a receipt.
const MAX_AMOUNT = 1e10;

const { fail } = require('../utils/http-error');

const MONEY_FIELDS = ['total', 'tax', 'subTotal'];
// Whether two values of one field say the same thing: amounts as numbers,
// with empty equal to empty and never to 0; text without case or edge spaces.
function sameValue(field, a, b) {
  const empty = v => v === null || v === undefined || v === '';
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  if (MONEY_FIELDS.includes(field)) return Number(a) === Number(b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
// The category a receipt reports under: its one line's, or its own while it
// has none. A split has no single category (null).
const categoryOf = e => (e.lines.length === 1 ? e.lines[0].category : e.lines.length > 1 ? null : e.category) || null;

// The change log, and the assistant's cached view of whoever the change
// touches: without this the assistant answered from a view up to 30 seconds
// older than the page it was asked on.
function _record(before, after, actor, via) {
  changes.record(before, after, actor, via);
  try {
    const { forgetSnapshot } = require('../assistant/conversation');
    forgetSnapshot(after.userId);
    if (actor && actor.id !== after.userId) forgetSnapshot(actor.id);
  } catch { /* the assistant is not loaded */ }
}

// May this person change this receipt's details at all, and if not, why not.
function detailsBlocked(e, actor) {
  if (!e) return { status: 404, error: 'Expense not found' };
  if (!canEditDetails(actor, e.userId, e.companyId)) return { status: 404, error: 'Expense not found' };
  if (wf.isPosted(e)) return { status: 409, error: 'This receipt is in a case that has been posted to Xero, which is final.' };
  if (wf.inPosting(e)) return { status: 409, error: 'This receipt\'s case is being posted to Xero right now. Try again once that has finished.' };
  if (e.status === 'duplicate') return { status: 400, error: 'A duplicate cannot be edited; delete it or restore it first' };
  // The reader's answer would land on top of whatever was typed meanwhile.
  if (e.status === 'reading') return { status: 409, error: 'This receipt is still being read. Edit it once the reading is done.' };
  return null;
}
function _assertDetails(e, actor) {
  const blocked = detailsBlocked(e, actor);
  if (blocked) fail(blocked.status, blocked.error);
}

// Checks and cleans a patch of detail fields. Unknown keys are ignored.
function cleanPatch(body = {}) {
  const patch = {};
  for (const k of EDITABLE) {
    if (body[k] === undefined) continue;
    const v = body[k] === '' ? null : body[k];
    if (v !== null && typeof v === 'object') fail(400, `${k} must be a value, not an object`);
    patch[k] = v;
  }
  for (const [k, max] of Object.entries(MAX_TEXT)) if (typeof patch[k] === 'string') patch[k] = patch[k].trim().slice(0, max);
  if (patch.currency !== undefined && patch.currency !== null) {
    patch.currency = String(patch.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(patch.currency)) fail(400, 'Currency must be a 3-letter code like SGD or INR');
  }
  if (patch.receiptDate && !require('../intake/document').isoDate(String(patch.receiptDate))) fail(400, 'Date must be a real YYYY-MM-DD, not in the future');
  for (const k of ['total', 'tax', 'subTotal']) {
    if (patch[k] === undefined || patch[k] === null) continue;
    const n = Number(patch[k]);
    if (!(n >= 0) || n > MAX_AMOUNT) fail(400, `${k} must be a number from 0 up`);
    patch[k] = n;
  }
  if (patch.category !== undefined && patch.category !== null) {
    const c = canonicalCategory(patch.category);
    if (!c) fail(400, 'Unknown category');
    patch.category = c;
  }
  return patch;
}

// Merchant, date, amounts and the rest. Returns the updated expense.
async function editDetails(expenseId, body, actor, { via = 'app' } = {}) {
  const e = store.getExpense(expenseId);
  _assertDetails(e, actor);
  const patch = cleanPatch(body);
  if (!Object.keys(patch).length) return e;
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
  // So does a single line's category: the report's columns come from the
  // lines, so a category set only on the receipt would never reach the case.
  if (patch.category) {
    const lines = store.getLines(e.id);
    if (lines.length === 1 && lines[0].category !== patch.category) store.updateLine(lines[0].id, { category: patch.category });
  }
  // A new currency, date or amount changes what the base figure is. A rate
  // somebody typed was typed for the OLD currency, so a currency change drops
  // it and fetches afresh; a new date or total keeps it.
  if (patch.currency !== undefined || patch.receiptDate !== undefined || patch.total !== undefined) await applyFx(e.id, { force: currencyChanged });
  // A new total on a split leaves the lines behind. A receipt whose lines no
  // longer add up is not checked any more, whatever it was before; in a
  // claimed case it keeps its status and posting refuses it until the lines
  // are put right (xero/bills.js).
  let after = store.getExpense(e.id);
  if (after.status === 'reviewed' && after.lines.length && !store.linesReconcile(after.lines, store.toCents(after.total)) && !wf.isLocked(after)) {
    after = store.updateExpense(e.id, { status: 'review-needed' });
  }
  _record(e, after, actor, via);
  return after;
}

// The split into report lines. They must add up to the total, to the cent.
async function editLines(expenseId, lines, actor, { via = 'app' } = {}) {
  const e = store.getExpense(expenseId);
  _assertDetails(e, actor);
  if (!Array.isArray(lines) || !lines.length) fail(400, 'Send at least one line');
  if (lines.length > 100) fail(400, 'A receipt has at most 100 lines');
  for (const l of lines) {
    if (!l || typeof l !== 'object') fail(400, 'Every line needs an amount above zero');
    const n = Number(l.amount);
    if (!(n > 0) || n > MAX_AMOUNT) fail(400, 'Every line needs an amount above zero');
    if (l.category && !canonicalCategory(l.category)) fail(400, `Unknown category "${l.category}"`);
  }
  // A rate somebody typed for this receipt was typed for the receipt, not for
  // one way of splitting it; a re-split keeps it rather than quietly going
  // back to the provider's.
  const typed = e.lines.find(l => l.fxOverrideBy && l.fxRate > 0);
  const keep = typed ? { fxRate: typed.fxRate, fxRateDate: typed.fxRateDate, fxSource: typed.fxSource, fxFetchedAt: typed.fxFetchedAt,
                         fxPolicy: typed.fxPolicy, fxOverrideBy: typed.fxOverrideBy, fxOverrideReason: typed.fxOverrideReason } : {};
  try {
    store.replaceLines(e.id, lines.map(l => ({
      category: canonicalCategory(l.category) || e.category || 'Other',
      description: typeof l.description === 'string' ? l.description.slice(0, 250) : null,
      amount: Number(l.amount),
      onBehalfOf: typeof l.onBehalfOf === 'string' && l.onBehalfOf.trim() ? l.onBehalfOf.trim().slice(0, 80) : null,
      currency: e.currency,
      ...keep,
    })));
  } catch (err) { fail(400, err.message); }
  await applyFx(e.id);
  const after = store.getExpense(e.id);
  _record(e, after, actor, via);
  return after;
}

// A rate typed for this receipt, with a reason. A claimant's is held within
// 5% of the day's published rate; an admin's is not (fx/apply.js).
async function setRate(expenseId, { rate, reason }, actor, { via = 'app' } = {}) {
  const e = store.getExpense(expenseId);
  _assertDetails(e, actor);
  let after;
  try { after = await overrideFx(e.id, { rate, reason, actor }); }
  catch (err) { fail(400, err.message); }
  _record(e, after, actor, via);
  return after;
}

// The providers' rate again, dropping any typed one.
async function refreshRate(expenseId, actor, { via = 'app' } = {}) {
  const e = store.getExpense(expenseId);
  _assertDetails(e, actor);
  const out = await applyFx(e.id, { force: true });
  const after = store.getExpense(e.id);
  _record(e, after, actor, via);
  return { ...out, expense: after };
}

// ── Actions: the owner's, while the case is open ─────────────────────────────

const LOCKED = 'This receipt is in a case that has been claimed. Reopen the case to change it.';
const NOT_YOURS = 'Only the person who claimed this receipt can do that.';
function actionBlocked(e, actor) {
  if (!e || !canEditDetails(actor, e.userId, e.companyId)) return { status: 404, error: 'Expense not found' };
  if (!isOwner(actor, e.userId, e.companyId)) return { status: 403, error: NOT_YOURS };
  if (wf.isLocked(e)) return { status: 409, error: LOCKED };
  return null;
}
function _assertAction(e, actor) {
  const blocked = actionBlocked(e, actor);
  if (blocked) fail(blocked.status, blocked.error);
}

// What stands between a receipt and being marked reviewed, or null.
function reviewBlocked(e) {
  const missing = [];
  if (!e.merchant) missing.push('merchant');
  if (!e.receiptDate) missing.push('date');
  if (!e.currency) missing.push('currency');
  if (!(e.total > 0)) missing.push('total');
  if (missing.length) return `Fill in the ${missing.join(', ')} before marking this reviewed`;
  if (!store.linesReconcile(e.lines, store.toCents(e.total))) return 'The lines do not add up to the receipt total';
  return null;
}

// Reviewed (the owner saying the details are right) or back to review-needed.
function setStatus(expenseId, status, actor, { via = 'app' } = {}) {
  const e = store.getExpense(expenseId);
  _assertAction(e, actor);
  if (!['reviewed', 'review-needed'].includes(status)) fail(400, 'Status can be reviewed or review-needed here');
  // A duplicate is locked where it is (intake/dedup.js): checking it would let
  // the same receipt be filed and claimed twice.
  if (e.status === 'duplicate') fail(409, 'It is a duplicate; delete it or restore it first');
  if (e.status === 'reading') fail(409, 'It is still being read');
  if (status === 'reviewed') { const why = reviewBlocked(e); if (why) fail(400, why); }
  const patch = { status };
  // Marking it reviewed is the person saying the currency on it is right.
  if (status === 'reviewed' && e.errorMsg) patch.errorMsg = withoutCurrencyNote(e.errorMsg);
  const after = store.updateExpense(e.id, patch);
  _record(e, after, actor, via);
  return after;
}

// Moving a receipt into a case, out of one, or between two. Both ends have to
// be open, and the case has to be the owner's own.
function fileInCase(expenseId, reportId, actor, { via = 'app' } = {}) {
  const reports = require('../store/reports');
  const e = store.getExpense(expenseId);
  _assertAction(e, actor);
  if (e.status === 'duplicate') fail(400, 'A duplicate cannot be filed; delete it or restore it first');
  reportId = reportId || null;
  // Claimed on its own already: in a case it would be claimed a second time.
  if (reportId && e.claimedAt && !e.reportId) fail(409, 'This receipt was already claimed on its own. Unmark it as claimed before filing it in a case.');
  if (reportId === (e.reportId || null)) return e;
  const leaving = () => {
    if (!e.reportId) return;
    const cur = reports.getReport(e.reportId);
    if (cur && !wf.isEditable(cur)) fail(409, `A ${cur.status} case cannot be changed`);
    reports.removeExpense(e.reportId, e.id);
  };
  if (reportId) {
    const r = reports.getReport(reportId);
    if (!r || r.companyId !== e.companyId) fail(404, 'Case not found');
    if (r.userId !== e.userId || r.userId !== actor.id) fail(403, 'That case belongs to someone else');
    if (!wf.isEditable(r)) fail(409, `A ${r.status} case cannot take more receipts`);
    leaving();
    reports.addExpense(r.id, e.id);
  } else leaving();
  const after = store.getExpense(e.id);
  _record(e, after, actor, via);
  return after;
}

// What the person looking at a receipt may do with it, for the page to show.
function permissions(e, actor) {
  const owner = isOwner(actor, e.userId, e.companyId);
  return {
    isOwner: owner,
    canEditDetails: !detailsBlocked(e, actor),
    // Filing, checking, re-reading, deleting: the owner's, while the case is open.
    canAct: owner && !wf.isLocked(e),
    posted: wf.isPosted(e),
  };
}

module.exports = { editDetails, editLines, setRate, refreshRate, cleanPatch, detailsBlocked, permissions, sameValue, categoryOf,
                   setStatus, fileInCase, actionBlocked, reviewBlocked, EDITABLE, MAX_AMOUNT };
