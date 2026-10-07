const db = require('../db');

// The change log for a receipt's details. Written by receipts/edit.js — the
// one way a person or the assistant changes a receipt — so whoever changed
// what, through whichever door, ends up here.

const FIELDS = {
  merchant: 'Merchant', receiptDate: 'Date', receiptTime: 'Time', invoiceNo: 'Invoice no.', currency: 'Currency',
  total: 'Total', tax: 'Tax', subTotal: 'Subtotal', purpose: 'Purpose', description: 'Description', category: 'Category',
};
const LABEL = { ...FIELDS, lines: 'Lines', rate: 'Exchange rate', status: 'Status', case: 'Case' };
const STATUS_WORDS = { reviewed: 'checked', 'review-needed': 'to check', reading: 'being read', duplicate: 'duplicate', rejected: 'rejected' };
const _caseNo = id => (id ? (require('./reports').head(id) || {}).number || 'a case' : null);

const { formatAmount } = require('../utils/money');
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

module.exports = { record, list, diff, linesSummary, rateSummary, FIELDS, LABEL };
