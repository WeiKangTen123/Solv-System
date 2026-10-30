const db = require('../db');

// The change log for a receipt's details. Written by receipts/edit.js — the
// one way a person or the assistant changes a receipt — so whoever changed
// what, through whichever door, ends up here.

const FIELDS = {
  merchant: 'Merchant', receiptDate: 'Date', receiptTime: 'Time', invoiceNo: 'Invoice no.', currency: 'Currency',
  total: 'Total', tax: 'Tax', subTotal: 'Subtotal', purpose: 'Purpose', description: 'Description', category: 'Category',
};
const LABEL = { ...FIELDS, printed: 'As printed', lines: 'Lines', rate: 'Exchange rate', status: 'Status', case: 'Case' };
const STATUS_WORDS = { reviewed: 'checked', 'review-needed': 'to check', reading: 'being read', duplicate: 'duplicate', rejected: 'rejected' };
// A draft has no number until it is created, so it is named as a draft.
const _caseNo = id => {
  if (!id) return null;
  const h = require('./reports').head(id);
  return (h && h.number) || (h && h.status === 'draft' ? 'a draft case' : 'a case');
};

const { formatAmount } = require('../utils/money');
const { describeChange } = require('../receipts/printed');
const money = n => formatAmount(n, { empty: '' });
const _str = v => (v === null || v === undefined ? '' : String(v));

// "Lodging 43,131.36 · Meals 8,344.07 (Lim Wei Jie)": what the lines say,
// in a form two versions can be compared by and a person can read.
function linesSummary(lines = []) {
  return lines.map(l => `${l.category || 'Uncategorised'} ${money(l.amount)}${l.onBehalfOf ? ` (${l.onBehalfOf})` : ''}`).join(' · ');
}
// The rate on the lines, and where it came from.
function rateSummary(lines = []) {
  const l = lines[0];
  if (!l || !(l.fxRate > 0) || l.fxSource === 'base') return '';
  return l.fxSource === 'manual' ? `${Number(l.fxRate.toPrecision(6))} typed${l.fxOverrideReason ? `: ${l.fxOverrideReason}` : ''}` : `${Number(l.fxRate.toPrecision(6))} ${l.fxSource}`;
}

// What differs between two versions of one expense, field by field.
function diff(before, after) {
  const out = [];
  for (const f of Object.keys(FIELDS)) {
    const a = ['total', 'tax', 'subTotal'].includes(f) ? money(before[f]) : _str(before[f]);
    const b = ['total', 'tax', 'subTotal'].includes(f) ? money(after[f]) : _str(after[f]);
    if (a !== b) out.push({ field: f, oldValue: a || null, newValue: b || null });
  }
  // The receipt as printed, row by row in words ("SST 6% 1.58 → 1.60 · Added
  // Teh tarik 5.60", at most five rows and then how many more). One row of
  // the log: a list of rows has no single old and new value, so the sentence
  // is the new value and the old one is empty.
  const pr = describeChange(before.printed, after.printed);
  if (pr) out.push({ field: 'printed', oldValue: null, newValue: pr });
  const la = linesSummary(before.lines), lb = linesSummary(after.lines);
  if (la !== lb) out.push({ field: 'lines', oldValue: la || null, newValue: lb || null });
  const ra = rateSummary(before.lines), rb = rateSummary(after.lines);
  if (ra !== rb && (ra || rb)) out.push({ field: 'rate', oldValue: ra || null, newValue: rb || null });
  if ((before.status || null) !== (after.status || null)) {
    out.push({ field: 'status', oldValue: STATUS_WORDS[before.status] || before.status || null, newValue: STATUS_WORDS[after.status] || after.status || null });
  }
  if ((before.reportId || null) !== (after.reportId || null)) out.push({ field: 'case', oldValue: _caseNo(before.reportId), newValue: _caseNo(after.reportId) });
  return out;
}

// Records what changed between `before` and `after`, as `actor`, through
// `via`. Returns the rows written. A change to a receipt in a claimed case
// is also written to the case's history, where the claim's record lives.
function record(before, after, actor, via = 'app') {
  if (!before || !after) return [];
  const rows = diff(before, after);
  if (!rows.length) return [];
  const at = new Date().toISOString();
  const role = actor && actor.id === after.userId ? 'owner' : 'admin';
  const ins = db.prepare('INSERT INTO expense_changes (expense_id, actor_id, actor_role, via, field, old_value, new_value, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (const r of rows) ins.run(after.id, actor ? actor.id : null, role, via, r.field, r.oldValue, r.newValue, at);
  })();
  if (after.reportId) {
    const rep = db.prepare('SELECT status FROM expense_reports WHERE id = ?').get(after.reportId);
    if (rep && rep.status === 'claimed') {
      require('./reports').addEvent(after.reportId, actor ? actor.id : null, 'edited',
        `${after.merchant || 'A receipt'}: ${rows.map(r => LABEL[r.field]).join(', ')} changed after the case was claimed${role === 'admin' ? ' (by an admin)' : ''}`);
    }
  }
  return rows;
}

function list(expenseId) {
  return db.prepare(`SELECT c.*, u.name AS actor_name, u.email AS actor_email FROM expense_changes c
                     LEFT JOIN users u ON u.id = c.actor_id WHERE c.expense_id = ? ORDER BY c.id DESC`).all(expenseId)
    .map(r => ({ id: r.id, field: r.field, label: LABEL[r.field] || r.field, oldValue: r.old_value, newValue: r.new_value, at: r.at,
                 via: r.via, actorRole: r.actor_role, actorId: r.actor_id, actorName: r.actor_name || r.actor_email || null }));
}

// ── Checks one after another ─────────────────────────────────────────────────
// A person checking a case's receipts one at a time is one thing they did,
// not thirty: the case's history keeps one `checked` event for the run
// (store/reports.js noteChecked) and the Activity tab folds the receipts'
// own rows into it (reports/activity.js). Both have to agree on what one run
// is, so it is said once, here: checks by the same person, each within
// RUN_GAP_MS of the next, counted back from the newest.
const RUN_GAP_MS = 15 * 60 * 1000;
// `rows` are { at, ... }, newest first. Returns the run ending at the first.
function checkRun(rows, gapMs = RUN_GAP_MS) {
  const out = [];
  for (const r of rows) {
    if (out.length && Date.parse(out[out.length - 1].at) - Date.parse(r.at) > gapMs) break;
    out.push(r);
  }
  return out;
}
// The receipts of a case this person marked checked from `since` on, newest
// first. Only receipts still in the case: one taken out meanwhile wrote an
// event of its own, which ended the run.
function checksInCase(reportId, actorId, since = '') {
  return db.prepare(`SELECT c.expense_id AS expenseId, c.at FROM expense_changes c JOIN expenses e ON e.id = c.expense_id
                     WHERE e.report_id = ? AND c.actor_id = ? AND c.field = 'status' AND c.new_value = ? AND c.at >= ?
                     ORDER BY c.at DESC, c.id DESC`).all(reportId, actorId, STATUS_WORDS.reviewed, since || '');
}

// "Grab Taxi, SGD 12.50, 1 Sep 2026": a receipt named the way a person would
// find it again, for a case's history once the receipt is no longer there
// to point at (taken out, or deleted).
function receiptName(e) {
  if (!e) return 'A receipt';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(e.receiptDate || '')) ? require('../reports/cover-suggest').dayRange(e.receiptDate, e.receiptDate) : null;
  return [e.merchant || 'A receipt with no merchant', e.total !== null && e.total !== undefined ? `${e.currency ? `${e.currency} ` : ''}${money(e.total)}` : null, day]
    .filter(Boolean).join(', ');
}

module.exports = { record, list, diff, linesSummary, rateSummary, checkRun, checksInCase, receiptName, FIELDS, LABEL, STATUS_WORDS, RUN_GAP_MS };
