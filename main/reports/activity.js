const db = require('../db');
const changes = require('../store/changes');
const { dayRange } = require('./cover-suggest');
const { SOURCE_NAME } = require('../fx/sources');

// A case's Activity tab: what happened to the case and to the receipts in it,
// newest first, one list. Two records feed it and neither is enough alone:
//
//   report_events     the case's own history (store/reports.js): created,
//                     details edited, checked, taken out, claimed, Xero, and
//                     the AI changing the details (`ai_details`).
//   expense_changes   each receipt's own log (store/changes.js): who changed
//                     which field from what to what, through which door.
//
// Receipts are those in the case now, from the time they came in (what was
// done to one in My receipts or another case is that receipt's history, on its
// own page), and those that were taken out or moved away, while they were
// here. A receipt's log names cases by number, so a move out of this case is
// known by its number, or by the `removed` event it wrote beside it.
//
// The two records overlap, and an entry is said once:
//
//   - a run of checks is one `checked` event carrying the receipts; their
//     status rows are folded into it
//   - a receipt taken out is the `removed` event, linked to the receipt by
//     the case row written with it
//   - an edit after a claim wrote a case event naming the fields; the rows
//     say more, so they stay, marked, and the event goes
//
// Who did it (`actor.type`): a person, by name (an admin marked as one; the
// assistant applying what they asked, or a receipt read again at their
// request, is still them, and `via` says so); the AI, when it changed the
// details on its own (`ai_details`); or the system: Xero's answers, and
// anything with nobody behind it.
const DEFAULT_LIMIT = 100, MAX_LIMIT = 500;
const PAIR_MS = 5000;          // a `removed` event is written straight after its receipt's row
const AFTER_CLAIM_MS = 2000;   // and the claimed-case note straight after the rows it names

const LABEL = {
  merchant: 'Merchant', receiptDate: 'Date', receiptTime: 'Time', invoiceNo: 'Invoice no.', currency: 'Currency',
  total: 'Total', tax: 'Tax', subTotal: 'Subtotal', purpose: 'Purpose', description: 'Description', category: 'Category',
  lines: 'Lines', rate: 'Exchange rate', status: 'Status', case: 'Case',
};
const MONEY = new Set(['total', 'tax', 'subTotal']);
const CHECKED = changes.STATUS_WORDS.reviewed, TO_CHECK = changes.STATUS_WORDS['review-needed'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const _ms = at => Date.parse(at) || 0;
const _cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
// "title, dates and nights"
const _and = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const _receipts = n => `${n} receipt${n === 1 ? '' : 's'}`;

// ── Values as a person reads them ────────────────────────────────────────────
// The log keeps amounts without their currency (store/changes.js money), so
// the currency is put back from the receipt: the one it had at the time,
// worked back from today's through any change of currency since.
function _value(field, v, currency) {
  if (v === null || v === undefined || v === '') return null;
  if (MONEY.has(field)) return currency ? `${currency} ${v}` : v;
  if (field === 'receiptDate' && ISO_DAY.test(v)) return dayRange(v, v);
  if (field === 'rate') {
    // "0.0162 frankfurter" / "0.0165 typed: card rate"
    const m = String(v).match(/^(\S+) (typed)(?:: (.*))?$/) || String(v).match(/^(\S+) (\S+)$/);
    if (!m) return v;
    if (m[2] === 'typed') return `${m[1]}, typed${m[3] ? `: ${m[3]}` : ''}`;
    return `${m[1]} (${SOURCE_NAME[m[2]] || m[2]})`;
  }
  return v;
}
// "Total SGD 10.00 → SGD 12.50", "Purpose set to Client dinner".
function _change(field, oldV, newV, currency) {
  const label = field === 'lines' && currency ? `Lines (${currency})` : LABEL[field] || field;
  if (oldV && newV) return `${label} ${oldV} → ${newV}`;
  if (newV) return `${label} set to ${newV}`;
  if (oldV) return `${label} cleared (was ${oldV})`;
  return `${label} changed`;
}

// Each receipt's currency before and after every row of its log, newest first
// from the currency it has today. One save is one moment (one `at`), and a
// currency changed in it applies to the amounts changed with it.
function _currencies(rows, today) {
  const out = new Map();
  let cur = today || null;
  const byAt = [...rows].sort((a, b) => b.id - a.id);
  for (let i = 0; i < byAt.length;) {
    const at = byAt[i].at, group = [];
    while (i < byAt.length && byAt[i].at === at) group.push(byAt[i++]);
    const c = group.find(r => r.field === 'currency');
    const after = c ? c.new_value || cur : cur, before = c ? c.old_value : cur;
    for (const r of group) out.set(r.id, { before, after });
    cur = before;
  }
  return out;
}

// ── Who ──────────────────────────────────────────────────────────────────────
function _person(id, name, email, isAdmin, via) {
  return { type: 'person', id, name: name || email || 'Someone no longer here', ...(isAdmin ? { role: 'admin' } : {}), ...(via ? { via } : {}) };
}
const SYSTEM = { type: 'system', name: 'Solv' }, XERO = { type: 'system', name: 'Xero' }, AI = { type: 'ai', name: 'AI' };

function _eventActor(ev, ownerId) {
  if (ev.action === 'ai_details') return AI;
  if (ev.action === 'xero_failed') return XERO;
  if (!ev.actor_id) return SYSTEM;
  return _person(ev.actor_id, ev.actor_name, ev.actor_email, ev.actor_user_role === 'admin' && ev.actor_id !== ownerId,
                 ev.action === 'details_edited' && String(ev.note || '').endsWith(' (via the assistant)') ? 'assistant' : null);
}
function _rowActor(row) {
  if (!row.actor_id) return SYSTEM;
  return _person(row.actor_id, row.actor_name, row.actor_email, row.actor_role === 'admin', row.via === 'assistant' || row.via === 'reread' ? row.via : null);
}

// ── The case's events ────────────────────────────────────────────────────────
function _eventItem(ev, ownerId) {
  const note = ev.note || null;
  const item = { id: `e${ev.id}`, at: ev.at, actor: _eventActor(ev, ownerId), scope: 'case', action: ev.action, text: '', detail: null, note,
                 receiptId: null, merchant: null, field: null, old: null, new: null };
  const set = (text, detail = null, action = ev.action) => Object.assign(item, { text, detail, action });
  let m;
  switch (ev.action) {
    case 'created': return set(note === 'draft' ? 'Started a draft' : 'Created the case');
    case 'opened': return set('Created the case from the draft');
    case 'claimed': return set('Marked the case claimed');
    case 'reopened': return set('Reopened the case');
    case 'details_edited': {
      const fields = String(note || '').replace(/ \(via the assistant\)$/, '').split(', ').filter(Boolean);
      return set(fields.length ? `Edited the details: ${_and(fields)}` : 'Edited the details', fields.length ? _cap(_and(fields)) : null);
    }
    case 'ai_details': return set(note ? `Updated the details from the receipts: ${note}` : 'Updated the details from the receipts', note);
    case 'checked': return set(`Checked ${note || 'receipts'}`);
    case 'removed':
      if ((m = String(note || '').match(/^(.*) \(moved to (.*)\)$/))) return set(`Moved ${m[1]} to ${m[2]}`, m[1]);
      return set(`Took ${note || 'a receipt'} out of the case`, note);
    case 'deleted': return set(`Deleted ${note || 'a receipt'}`, note);
    case 'posted': return set(note ? `Posted to Xero: ${note.replace(/^Xero bill /, 'draft bill ')}` : 'Posted to Xero', note);
    case 'xero_failed': return set(/^Xero also made/.test(note || '') ? note : `Xero refused the bill${note ? `: ${note}` : ''}`, note);
    case 'edited':
      // Older events say what they were only in their note; the per diem and
      // mileage are written this way still (reports/allowances.js).
      if ((m = String(note || '').match(/^Per diem (added|replaced): (.*)$/))) return set(`${m[1] === 'added' ? 'Added a per diem' : 'Replaced the per diem'}: ${m[2]}`, m[2], 'per_diem');
      if ((m = String(note || '').match(/^Mileage added: (.*)$/))) return set(`Added mileage: ${m[1]}`, m[1], 'mileage');
      if (/^Merged /.test(note || '')) return set(note, null, 'merged');
      if (/ changed after the case was claimed( \(by an admin\))?$/.test(note || '')) return set(note, null, 'edited_after_claim');
      return set(note || 'Edited the case', null);
    default: {
      const said = _cap(String(ev.action || 'something').replace(/_/g, ' '));
      return set(note ? `${said}: ${note}` : said, note);
    }
  }
}

// ── The receipts' rows ───────────────────────────────────────────────────────
// `side` is how a `case` row moved the receipt relative to this case: 'in',
// 'out', or undefined for any other field.
function _rowItem(row, side, receipt, currency) {
  const m = receipt.merchant || 'a receipt';
  const cur = currency || {};
  const oldV = _value(row.field, row.old_value, cur.before), newV = _value(row.field, row.new_value, cur.after);
  const item = { id: `c${row.id}`, at: row.at, actor: _rowActor(row), scope: 'receipt', action: 'edited', text: '', detail: null,
                 receiptId: receipt.id, merchant: receipt.merchant || null, field: row.field, old: oldV, new: newV };
  const set = (action, text, detail = null) => Object.assign(item, { action, text, detail });
  if (row.field === 'case') {
    if (side === 'in') return oldV ? set('moved_in', `Moved ${m} here from ${oldV}`) : set('filed', `Added ${m} to the case`);
    return newV ? set('moved_out', `Moved ${m} to ${newV}`) : set('taken_out', `Took ${m} out of the case`);
  }
  if (row.field === 'status') {
    if (newV === CHECKED) return set('checked', `Checked ${m}`);
    if (oldV === CHECKED && newV === TO_CHECK) return set('unchecked', `Marked ${m} to check again`);
    return set('status', `${_cap(m)} is now ${newV || 'without a status'}`, _change('status', oldV, newV));
  }
  const detail = _change(row.field, oldV, newV, row.field === 'lines' ? cur.after : null);
  return set('edited', `Edited ${m}: ${detail[0].toLowerCase()}${detail.slice(1)}`, detail);
}

// ── Putting it together ──────────────────────────────────────────────────────
function _events(reportId) {
  return db.prepare(`SELECT ev.*, u.name AS actor_name, u.email AS actor_email, u.role AS actor_user_role
                     FROM report_events ev LEFT JOIN users u ON u.id = ev.actor_id WHERE ev.report_id = ? ORDER BY ev.id`).all(reportId);
}
function _rows(expenseIds) {
  if (!expenseIds.length) return [];
  return db.prepare(`SELECT c.*, u.name AS actor_name, u.email AS actor_email FROM expense_changes c
                     LEFT JOIN users u ON u.id = c.actor_id
                     WHERE c.expense_id IN (SELECT value FROM json_each(?)) ORDER BY c.id`).all(JSON.stringify(expenseIds));
}

// Every `removed` event, and the receipt row written with it: the row is how
// the event knows which receipt it was, and the receipt is how a move out of
// a draft (named "a draft case" in its log) is found at all.
function _pairRemoved(report, events) {
  const removed = events.filter(ev => ev.action === 'removed');
  const out = new Map();   // event id → row
  if (!removed.length) return out;
  const from = new Date(_ms(removed[0].at) - PAIR_MS).toISOString(), to = removed[removed.length - 1].at;
  const rows = db.prepare(`SELECT c.id, c.expense_id, c.actor_id, c.at, c.old_value FROM expense_changes c JOIN expenses e ON e.id = c.expense_id
                           WHERE e.user_id = ? AND e.company_id = ? AND c.field = 'case' AND c.old_value IS NOT NULL AND c.at >= ? AND c.at <= ?
                           ORDER BY c.id`).all(report.userId, report.companyId, from, to);
  const used = new Set();
  for (const ev of removed) {
    // The latest one before it: a bulk move writes row, event, row, event.
    let best = null;
    for (const r of rows) {
      if (used.has(r.id) || r.actor_id !== ev.actor_id || r.at > ev.at || _ms(ev.at) - _ms(r.at) > PAIR_MS) continue;
      if (!best || r.id > best.id) best = r;
    }
    if (best) { used.add(best.id); out.set(ev.id, best); }
  }
  return out;
}

function caseActivity(report, { before = null, limit = DEFAULT_LIMIT } = {}) {
  const number = report.number || null;
  const events = _events(report.id);
  const paired = _pairRemoved(report, events);
  const pairedOut = new Set([...paired.values()].map(r => r.id));

  // The receipts: in the case now, and those that left it.
  const receipts = new Map(report.expenses.map(e => [e.id, { id: e.id, merchant: e.merchant, currency: e.currency, inCase: true }]));
  const gone = new Set([...paired.values()].map(r => r.expense_id));
  if (number) {
    for (const x of db.prepare(`SELECT DISTINCT c.expense_id AS id FROM expense_changes c JOIN expenses e ON e.id = c.expense_id
                                WHERE e.user_id = ? AND e.company_id = ? AND c.field = 'case' AND (c.old_value = ? OR c.new_value = ?)`)
      .all(report.userId, report.companyId, number, number)) gone.add(x.id);
  }
  const away = [...gone].filter(id => !receipts.has(id));
  if (away.length) {
    for (const e of db.prepare('SELECT id, merchant, currency FROM expenses WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(away))) {
      receipts.set(e.id, { id: e.id, merchant: e.merchant, currency: e.currency, inCase: false });
    }
  }

  // Each receipt's rows from while it was here.
  const byReceipt = new Map();
  for (const row of _rows([...receipts.keys()])) {
    if (!byReceipt.has(row.expense_id)) byReceipt.set(row.expense_id, []);
    byReceipt.get(row.expense_id).push(row);
  }
  const kept = [];   // { row, side, receipt, currency }
  for (const [id, rows] of byReceipt) {
    const receipt = receipts.get(id);
    const currencies = _currencies(rows, receipt.currency);
    const caseRows = rows.filter(r => r.field === 'case');
    // The last move of a receipt that is here now brought it here, whatever
    // its log calls the case (a draft then, or a case since merged into this).
    const lastIn = receipt.inCase ? caseRows[caseRows.length - 1] : null;
    const isIn = r => r === lastIn || (number && r.new_value === number);
    const isOut = r => pairedOut.has(r.id) || (number && r.old_value === number);
    let here = caseRows.length ? isOut(caseRows[0]) : receipt.inCase;
    for (const row of rows) {
      if (row.field === 'case') {
        if (isIn(row)) { kept.push({ row, side: 'in', receipt, currency: currencies.get(row.id) }); here = true; }
        else if (isOut(row)) { kept.push({ row, side: 'out', receipt, currency: currencies.get(row.id) }); here = false; }
        else here = false;
      } else if (here) kept.push({ row, side: undefined, receipt, currency: currencies.get(row.id) });
    }
  }

  const items = [];
  const folded = new Set();   // row ids said by an event
  const rowsByActor = new Map();
  for (const k of kept) {
    const key = k.row.actor_id || '';
    if (!rowsByActor.has(key)) rowsByActor.set(key, []);
    rowsByActor.get(key).push(k);
  }

  events.forEach((ev, i) => {
    const item = _eventItem(ev, report.userId);
    const mine = rowsByActor.get(ev.actor_id || '') || [];
    if (ev.action === 'checked' && ev.actor_id) {
      // The run of checks this event stands for: from the event before it,
      // up to it, each within the run's gap of the next (store/changes.js).
      // A receipt deleted since has no rows left, so the count is the
      // event's own when that is more.
      const since = i > 0 ? events[i - 1].at : '';
      const candidates = mine.filter(k => k.row.field === 'status' && k.row.new_value === CHECKED && !folded.has(k.row.id)
                                          && k.row.at <= ev.at && k.row.at >= since)
        .sort((a, b) => _ms(b.row.at) - _ms(a.row.at) || b.row.id - a.row.id);
      const run = changes.checkRun([{ at: ev.at }, ...candidates.map(k => ({ at: k.row.at, k }))]).slice(1).map(x => x.k);
      if (run.length) {
        for (const k of run) folded.add(k.row.id);
        const seen = new Map();
        for (const k of [...run].reverse()) if (!seen.has(k.receipt.id)) seen.set(k.receipt.id, { id: k.receipt.id, merchant: k.receipt.merchant || null, inCase: k.receipt.inCase });
        item.receipts = [...seen.values()];
        const noted = Number((String(ev.note || '').match(/^(\d+) receipts?$/) || [])[1]) || 0;
        item.text = `Checked ${_receipts(Math.max(seen.size, noted))}`;
      }
    } else if (ev.action === 'removed' && paired.has(ev.id)) {
      const row = paired.get(ev.id);
      const receipt = receipts.get(row.expense_id);
      folded.add(row.id);
      if (receipt) Object.assign(item, { receiptId: receipt.id, merchant: receipt.merchant || null, inCase: receipt.inCase });
    } else if (item.action === 'edited_after_claim') {
      const named = mine.filter(k => k.row.at <= ev.at && _ms(ev.at) - _ms(k.row.at) <= AFTER_CLAIM_MS);
      if (named.length) { for (const k of named) k.afterClaim = true; return; }
    }
    items.push(item);
  });
  for (const k of kept) {
    if (folded.has(k.row.id)) continue;
    const item = _rowItem(k.row, k.side, k.receipt, k.currency);
    if (k.afterClaim) Object.assign(item, { afterClaim: true, text: `${item.text}, after the case was claimed` });
    item.inCase = k.receipt.inCase;
    items.push(item);
  }

  // Newest first; at one moment the case's event before the rows it sums up.
  items.sort((a, b) => _ms(b.at) - _ms(a.at) || (a.scope === b.scope ? Number(b.id.slice(1)) - Number(a.id.slice(1)) : a.scope === 'case' ? -1 : 1));
  const shown = before ? items.filter(x => _ms(x.at) < _ms(before)) : items;
  const n = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  let page = shown.slice(0, n);
  // A page never ends inside one moment: the next is asked for "before" the
  // last one's time, which would skip the rest of a save cut in half.
  if (page.length === n) {
    const last = page[page.length - 1].at;
    while (page.length < shown.length && shown[page.length].at === last) page = shown.slice(0, page.length + 1);
  }
  return { items: page, next: page.length < shown.length ? page[page.length - 1].at : null };
}

module.exports = { caseActivity, DEFAULT_LIMIT, MAX_LIMIT };
