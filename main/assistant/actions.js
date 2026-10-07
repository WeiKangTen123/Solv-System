const store   = require('../store/expenses');
const changes = require('../store/changes');
const edit    = require('../receipts/edit');
const astore  = require('./store');
const logger  = require('../utils/logger');

// Pressing Apply on a card the assistant made. The change goes through
// receipts/edit.js, exactly as if the person had made it on the page, and is
// logged as having come through the assistant. Only the person the card was
// made for can apply it, once, within a day.

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function fail(status, message) { const err = new Error(message); err.status = status; throw err; }
const _stale = what => fail(409, `The receipt changed after this was proposed: ${what}. Ask the assistant again.`);

// A receipt's exchange rate as a rate card sees it, stored on the card when
// it is made (tools.js) and compared again on Apply.
function rateBasis(e) {
  const l = (e && e.lines[0]) || {};
  return { currency: (e && e.currency) || null, rate: l.fxRate ?? null, source: l.fxSource ?? null, reason: l.fxOverrideReason ?? null };
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
        const now = k === 'category' ? edit.categoryOf(cur) : cur[k];
        if (!edit.sameValue(k, now, was)) _stale(`${changes.LABEL[k] || k} is now ${now ?? 'empty'}`);
      }
      return edit.editDetails(p.expenseId, p.patch, actor, opts);
    }
    case 'edit_lines': {
      const cur = store.getExpense(p.expenseId);
      if (!cur) fail(404, 'The receipt is gone.');
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
    case 'mark_reviewed': return edit.setStatus(p.expenseId, 'reviewed', actor);
    case 'file_in_case':  return edit.fileInCase(p.expenseId, p.caseId || null, actor);
    default: return fail(400, 'Unknown change');
  }
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

module.exports = { apply, dismiss, rateBasis, MAX_AGE_MS };
