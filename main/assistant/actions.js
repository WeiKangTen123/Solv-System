const store   = require('../store/expenses');
const changes = require('../store/changes');
const edit    = require('../receipts/edit');
const reports = require('../store/reports');
const wf      = require('../reports/workflow');
const { coverPatch, sameCover } = require('../reports/cover-patch');
const astore  = require('./store');
const logger  = require('../utils/logger');

// Pressing Apply on a card the assistant made. The change goes through
// receipts/edit.js, exactly as if the person had made it on the page, and is
// logged as having come through the assistant. Only the person the card was
// made for can apply it, once, within a day.

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const { fail } = require('../utils/http-error');
const _stale = what => fail(409, `The receipt changed after this was proposed: ${what}. Ask the assistant again.`);

// A receipt's exchange rate as a rate card sees it, stored on the card when
// it is made (tools.js) and compared again on Apply.
function rateBasis(e) {
  const l = (e && e.lines[0]) || {};
  return { currency: (e && e.currency) || null, rate: l.fxRate ?? null, source: l.fxSource ?? null, reason: l.fxOverrideReason ?? null };
}
// A receipt's category as a card sees it. A receipt kept as printed has the
// receipt's own while every line is in it: its two lines, the claimant's and
// a colleague's, both Meals, say Meals. Otherwise a single line's, as ever.
function categoryNow(e) {
  if (e && e.printed && e.lines.length && e.lines.every(l => l.category === e.category)) return e.category || null;
  return edit.categoryOf(e);
}
// A rate card refuses once the rate it was made against has moved: a rate
// typed on the page after the card was made was being overwritten by the
// card's, or by a refresh, without anybody seeing it.
function _rateUnchanged(cur, p) {
  // A rate is for one currency. An admin's rate card for INR applied after
  // the receipt became USD turned USD 10,000 into SGD 155.
  if (p.currency && cur.currency !== p.currency) _stale(`it is in ${cur.currency || 'no currency'} now, and the rate was for ${p.currency}`);
  if (!p.basis) return;
  const now = rateBasis(cur);
  if (now.currency !== p.basis.currency) _stale(`it is in ${now.currency || 'no currency'} now, and the card was made for ${p.basis.currency || 'no currency'}`);
  if (['rate', 'source', 'reason'].some(k => now[k] !== p.basis[k])) {
    _stale(`the exchange rate has changed since, to ${now.rate ?? 'none'}${now.source ? ` (${now.source}${now.reason ? `: ${now.reason}` : ''})` : ''}`);
  }
}

async function _do(a, actor) {
  const p = a.payload || {};
  const opts = { via: 'assistant' };
  switch (a.kind) {
    case 'edit_details': {
      // The card showed "from → to". If a field has moved since, the card is
      // describing a receipt that no longer exists.
      const cur = store.getExpense(p.expenseId);
      if (!cur) fail(404, 'The receipt is gone.');
      for (const [k, was] of Object.entries(p.from || {})) {
        const now = k === 'category' ? categoryNow(cur) : cur[k];
        if (!edit.sameValue(k, now, was)) _stale(`${changes.LABEL[k] || k} is now ${now ?? 'empty'}`);
      }
      return edit.editDetails(p.expenseId, p.patch, actor, opts);
    }
    case 'edit_lines': {
      const cur = store.getExpense(p.expenseId);
      if (!cur) fail(404, 'The receipt is gone.');
      // Read again as printed since the card was made: its lines come from
      // its items now, and the page's own refusal says so better than "its
      // lines are not the ones the card was made for".
      if (cur.printed) fail(409, edit.LINES_FROM_ITEMS);
      if (p.basis !== undefined && changes.linesSummary(cur.lines) !== p.basis) _stale('its lines are not the ones the card was made for');
      if (p.total !== undefined && !edit.sameValue('total', cur.total, p.total)) _stale(`the total is now ${cur.total}`);
      return edit.editLines(p.expenseId, p.lines, actor, opts);
    }
    case 'set_rate':
    case 'refresh_rate': {
      const cur = store.getExpense(p.expenseId);
      if (!cur) fail(404, 'The receipt is gone.');
      _rateUnchanged(cur, p);
      if (a.kind === 'set_rate') return edit.setRate(p.expenseId, { rate: p.rate, reason: p.reason }, actor, opts);
      return (await edit.refreshRate(p.expenseId, actor, opts)).expense;
    }
    case 'mark_reviewed': return edit.setStatus(p.expenseId, 'reviewed', actor, { via: 'assistant' });
    case 'file_in_case':  return edit.fileInCase(p.expenseId, p.caseId || null, actor, { via: 'assistant' });
    case 'edit_case':     return _editCase(p, actor);
    default: return fail(400, 'Unknown change');
  }
}

// A case details card (tools.js propose_case_details), asked again of the
// case as it is now: still the person's, still open, every field the card
// showed "from" still holding that, and the change still within the cover
// rules. Saved as the owner's own edit; updateReport writes the case's
// history entry and says it came through the assistant (store/reports.js),
// so there is one entry, not that one and another written here.
const FIELD_NAME = { kind: 'Kind', title: 'Title', periodFrom: 'From', periodTo: 'To', destination: 'Where', nights: 'Nights', purpose: 'Purpose', notes: 'Notes' };
const KIND_WORD = { trip: 'Trip', period: 'Month', case: 'Other' };
const _now = (k, v) => (v === null || v === undefined || v === '' ? 'empty' : k === 'kind' ? KIND_WORD[v] || v : String(v).length > 60 ? `${String(v).slice(0, 59)}…` : String(v));
function _editCase(p, actor) {
  const r = p.reportId ? reports.getReport(p.reportId) : null;
  if (!r) fail(404, 'The case is gone.');
  if (r.userId !== actor.id) fail(403, 'Only the person whose case this is can change its details.');
  if (r.status === 'draft' || !wf.isEditable(r)) fail(409, `A ${r.status} case cannot be edited here.`);
  for (const [k, was] of Object.entries(p.from || {})) {
    if (!sameCover(r[k], was)) fail(409, `The case changed after this was proposed: ${FIELD_NAME[k] || k} is now ${_now(k, r[k])}. Ask the assistant again.`);
  }
  let patch;
  try { patch = coverPatch(p.patch || {}); }
  catch (err) { fail(400, err.message); }
  if (!Object.keys(patch).length) fail(400, 'The card has nothing to change.');
  return reports.updateReport(r.id, patch, { actorId: actor.id, via: 'assistant' });
}

async function apply(id, actor) {
  const a = astore.getAction(id, actor.id);
  if (!a) fail(404, 'Not found');
  if (a.status !== 'pending') fail(409, `This was already ${a.status}.`);
  if (Date.now() - Date.parse(a.createdAt) > MAX_AGE_MS) {
    astore.decideAction(a.id, actor.id, 'failed', 'Expired: proposals last a day. Ask the assistant again.');
    return astore.getAction(a.id, actor.id);
  }
  if (!astore.claimAction(a.id, actor.id)) fail(409, 'This is already being applied.');
  try {
    await _do(a, actor);
    astore.decideAction(a.id, actor.id, 'applied', 'Done');
  } catch (err) {
    if (!err.status) logger.error('Applying an assistant change failed', { id: a.id, kind: a.kind, error: err.message });
    astore.decideAction(a.id, actor.id, 'failed', err.status ? err.message : 'It could not be applied because of a problem on the server.');
  } finally {
    // What the assistant already knew about this person is out of date now.
    require('./conversation').forgetSnapshot(actor.id);
  }
  return astore.getAction(a.id, actor.id);
}

function dismiss(id, actor) {
  const a = astore.getAction(id, actor.id);
  if (!a) fail(404, 'Not found');
  if (a.status !== 'pending' || astore.isBeingApplied(a)) fail(409, `This was already ${a.status === 'pending' ? 'being applied' : a.status}.`);
  astore.decideAction(a.id, actor.id, 'dismissed');
  return astore.getAction(a.id, actor.id);
}

module.exports = { apply, dismiss, rateBasis, categoryNow, MAX_AGE_MS };
