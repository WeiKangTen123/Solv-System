const db = require('../db');
const { newId } = require('../utils/ids');
const { localDate } = require('../utils/zone-date');
const expenses = require('./expenses');

// Expense reports: the cover, the workflow state and the audit trail. Lines
// and money live on the expenses; a report is a grouping with totals.
const now = () => new Date().toISOString();
const toCents = expenses.toCents, toDollars = expenses.toDollars;

function _row(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, userId: r.user_id, number: r.number, kind: r.kind, title: r.title, purpose: r.purpose,
    periodFrom: r.period_from, periodTo: r.period_to, destination: r.destination, nights: r.nights, status: r.status,
    advances: toDollars(r.advances_cents) ?? 0, claimedAt: r.claimed_at, xeroInvoiceId: r.xero_invoice_id, xeroError: r.xero_error, notes: r.notes,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// EXP-<year>-<0001>, counted per company. The counter lives on the company row
// so two reports created in the same millisecond cannot share a number. The
// year is the company's: the server's clock runs in UTC, so a case opened in
// Singapore before 08:00 on 1 January was numbered for the year before.
const nextNumber = db.transaction(companyId => {
  const c = db.prepare('SELECT next_report_no, timezone FROM companies WHERE id = ?').get(companyId);
  if (!c) throw new Error('Company not found');
  db.prepare('UPDATE companies SET next_report_no = next_report_no + 1 WHERE id = ?').run(companyId);
  return `EXP-${localDate(c.timezone).slice(0, 4)}-${String(c.next_report_no).padStart(4, '0')}`;
});

const COVER = { kind: 'kind', title: 'title', purpose: 'purpose', periodFrom: 'period_from', periodTo: 'period_to', destination: 'destination', nights: 'nights', notes: 'notes' };
// A trip has a destination, a period has a statement month, and a case is a
// bundle of receipts that arrived together and is neither.
const KINDS = new Set(['trip', 'period', 'case']);

const STATE = { status: 'status', claimedAt: 'claimed_at', xeroInvoiceId: 'xero_invoice_id', xeroError: 'xero_error' };

// The number, the case and its first event together: a failure part-way used
// to spend a case number on a case that did not exist.
function createReport(args) {
  return db.transaction(_createReport)(args);
}
function _createReport({ id = newId(), companyId, userId, kind = 'trip', title = null, purpose = null, periodFrom = null, periodTo = null, destination = null, nights = null, advances = 0, notes = null }) {
  const number = nextNumber(companyId);
  db.prepare(`INSERT INTO expense_reports (id, company_id, user_id, number, kind, title, purpose, period_from, period_to, destination, nights, status, advances_cents, notes, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
    .run(id, companyId, userId, number, KINDS.has(kind) ? kind : 'trip', title, purpose, periodFrom, periodTo, destination, nights, toCents(advances) || 0, notes, now());
  addEvent(id, userId, 'created', null);
  return getReport(id);
}

// pendingRates: receipts with an amount still waiting for a rate. noAmount:
// receipts with no amount at all yet (nothing read, nothing typed). They used
// to be one count, so an unread receipt was shown as "waiting for an
// exchange rate", which no rate would ever fix.
function _totals(list) {
  const byCategory = {};
  let baseCents = 0, pendingRates = 0, noAmount = 0, unreviewed = 0, lineCount = 0;
  for (const e of list) {
    if (e.status !== 'reviewed') unreviewed++;
    if (!e.lines.length) noAmount++;
    else if (e.fxPending) pendingRates++;
    for (const l of e.lines) {
      lineCount++;
      if (l.baseAmount === null || l.baseAmount === undefined) continue;
      const c = Math.round(l.baseAmount * 100);
      baseCents += c;
      const key = l.category || 'Other';
      byCategory[key] = (byCategory[key] || 0) + c;
    }
  }
  for (const k of Object.keys(byCategory)) byCategory[k] = byCategory[k] / 100;
  return { totalBase: baseCents / 100, byCategory, pendingRates, noAmount, unreviewed, expenseCount: list.length, lineCount };
}

// The case's own row and nothing else: its number, state and owner. For
// callers that need to know about a case without loading every receipt in it.
function head(id) {
  const r = id ? db.prepare('SELECT id, number, title, status, xero_invoice_id, xero_error, user_id, company_id, updated_at FROM expense_reports WHERE id = ?').get(id) : null;
  return r ? { id: r.id, number: r.number, title: r.title || null, status: r.status, xeroInvoiceId: r.xero_invoice_id || null, xeroError: r.xero_error || null, userId: r.user_id, companyId: r.company_id, updatedAt: r.updated_at || null } : null;
}

function getReport(id) {
  // The owner's name comes back here as well as from listReports: the Xero
  // confirmation asks finance to approve a bill "payable to <name>", and with
  // only listReports carrying it that read "payable to the claimant".
  const row = db.prepare(`SELECT r.*, u.name AS owner_name, u.email AS owner_email
                          FROM expense_reports r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`).get(id);
  const r = _row(row);
  if (!r) return null;
  r.ownerName = row.owner_name;
  r.ownerEmail = row.owner_email;
  const list = expenses.listExpenses({ reportId: id }).sort((a, b) => String(a.receiptDate || '').localeCompare(String(b.receiptDate || '')) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const totals = _totals(list);
  totals.reimbursement = Math.round((totals.totalBase - r.advances) * 100) / 100;
  return { ...r, expenses: list, totals, events: listEvents(id) };
}

function listReports({ companyId, userId, userIds, status } = {}) {
  const where = [], args = [];
  if (companyId) { where.push('r.company_id = ?'); args.push(companyId); }
  if (userId)    { where.push('r.user_id = ?'); args.push(userId); }
  if (userIds)   { if (!userIds.length) return []; where.push(`r.user_id IN (${userIds.map(() => '?').join(',')})`); args.push(...userIds); }
  if (status)    { const list = String(status).split(','); where.push(`r.status IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  const rows = db.prepare(`
    SELECT r.*, u.name AS owner_name, u.email AS owner_email,
      (SELECT COUNT(*) FROM expenses e WHERE e.report_id = r.id) AS expense_count,
      (SELECT SUM(l.base_cents) FROM expense_lines l JOIN expenses e ON e.id = l.expense_id WHERE e.report_id = r.id) AS base_cents,
      -- Receipts waiting for a rate, and receipts with no amount yet, as the
      -- case page counts them: one with three unpriced lines is one receipt
      -- waiting, not three.
      (SELECT COUNT(*) FROM expenses e WHERE e.report_id = r.id
         AND EXISTS (SELECT 1 FROM expense_lines l WHERE l.expense_id = e.id AND l.base_cents IS NULL)) AS pending_lines,
      (SELECT COUNT(*) FROM expenses e WHERE e.report_id = r.id
         AND NOT EXISTS (SELECT 1 FROM expense_lines l WHERE l.expense_id = e.id)) AS no_amount,
      (SELECT COUNT(*) FROM expenses e WHERE e.report_id = r.id AND e.status != 'reviewed') AS unreviewed
    FROM expense_reports r JOIN users u ON u.id = r.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC`).all(...args);
  return rows.map(x => ({ ..._row(x), ownerName: x.owner_name, ownerEmail: x.owner_email, expenseCount: x.expense_count, totalBase: toDollars(x.base_cents) ?? 0, pendingRates: x.pending_lines, noAmount: x.no_amount, unreviewed: x.unreviewed }));
}

function updateReport(id, patch) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries(COVER)) { if (patch[k] === undefined) continue; sets.push(`${col} = ?`); args.push(patch[k] === '' ? null : patch[k]); }
  if (patch.advances !== undefined) { sets.push('advances_cents = ?'); args.push(toCents(patch.advances) || 0); }
  sets.push('updated_at = ?'); args.push(now());
  db.prepare(`UPDATE expense_reports SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return getReport(id);
}

// Claiming a report for posting, atomically. postReport reads the row, checks
// it has no bill yet, and only writes back several seconds later once Xero has
// answered — so a second click inside that window passed the same check and
// made a second draft bill for the same report number. One UPDATE with the
// condition in its WHERE decides it: exactly one caller gets `true`.
//
// A marker older than POST_STALE_MS belongs to a post that died with its
// process, and is taken over rather than refusing every later attempt for
// good. A post that died after Xero made the bill but before it was recorded
// would make a second one on takeover, so every attempt at the same bill
// sends the same idempotency key (xero/bills.js) and Xero answers with the
// first bill instead.
//
// Only a claimed case can be claimed for posting, in the same statement: the
// check used to be made earlier, and a case could be reopened, changed and
// posted while the chart of accounts was loading.
const POSTING = 'posting';
const POST_STALE_MS = 10 * 60 * 1000;
function claimForPost(id) {
  const stale = new Date(Date.now() - POST_STALE_MS).toISOString();
  const info = db.prepare(`UPDATE expense_reports SET xero_error = ?, updated_at = ?
                           WHERE id = ? AND xero_invoice_id IS NULL AND status = 'claimed'
                             AND (COALESCE(xero_error, '') != ? OR COALESCE(updated_at, '') < ?)`)
    .run(POSTING, now(), id, POSTING, stale);
  return info.changes === 1;
}
// Whether a case is being posted right now: a fresh marker, not a dead one.
function isPosting(r) {
  if (!r || r.xeroError !== POSTING) return false;
  return !(r.updatedAt && Date.parse(r.updatedAt) < Date.now() - POST_STALE_MS);
}
// The bill Xero made, recorded once. A second attempt that also got a bill
// back (it should get the same one; see claimForPost) does not overwrite the
// first: false tells the caller so.
function recordBill(id, invoiceId, note) {
  return db.prepare('UPDATE expense_reports SET xero_invoice_id = ?, xero_error = ?, updated_at = ? WHERE id = ? AND xero_invoice_id IS NULL')
    .run(invoiceId, note, now(), id).changes === 1;
}
function releasePost(id, error = null) {
  db.prepare(`UPDATE expense_reports SET xero_error = ?, updated_at = ? WHERE id = ? AND xero_error = ?`)
    .run(error, now(), id, POSTING);
}

function setState(id, patch) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries(STATE)) { if (patch[k] === undefined) continue; sets.push(`${col} = ?`); args.push(patch[k]); }
  sets.push('updated_at = ?'); args.push(now());
  db.prepare(`UPDATE expense_reports SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return getReport(id);
}

function addExpense(reportId, expenseId) { return expenses.updateExpense(expenseId, { reportId }); }
function removeExpense(reportId, expenseId) {
  const e = expenses.getExpense(expenseId);
  if (!e || e.reportId !== reportId) return null;
  return expenses.updateExpense(expenseId, { reportId: null });
}
function deleteReport(id) { db.prepare('DELETE FROM expense_reports WHERE id = ?').run(id); }

function addEvent(reportId, actorId, action, note = null) {
  db.prepare('INSERT INTO report_events (report_id, actor_id, action, note, at) VALUES (?, ?, ?, ?, ?)').run(reportId, actorId || null, action, note, now());
}
function listEvents(reportId) {
  return db.prepare('SELECT ev.*, u.name AS actor_name, u.email AS actor_email FROM report_events ev LEFT JOIN users u ON u.id = ev.actor_id WHERE ev.report_id = ? ORDER BY ev.id').all(reportId)
    .map(x => ({ id: x.id, action: x.action, note: x.note, at: x.at, actorId: x.actor_id, actorName: x.actor_name || x.actor_email || null }));
}

module.exports = {
  claimForPost, releasePost, isPosting, recordBill, POST_STALE_MS, createReport, getReport, head, listReports, updateReport, setState, addExpense, removeExpense, deleteReport, addEvent, listEvents, nextNumber };
