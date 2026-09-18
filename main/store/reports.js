const db = require('../db');
const { newId } = require('../utils/ids');
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
    submittedAt: r.submitted_at, approvedBy: r.approved_by, approvedAt: r.approved_at, rejectedReason: r.rejected_reason,
    advances: toDollars(r.advances_cents) ?? 0, paidAt: r.paid_at, xeroInvoiceId: r.xero_invoice_id, xeroError: r.xero_error, notes: r.notes,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// EXP-<year>-<0001>, counted per company. The counter lives on the company row
// so two reports created in the same millisecond cannot share a number.
const nextNumber = db.transaction(companyId => {
  const c = db.prepare('SELECT next_report_no FROM companies WHERE id = ?').get(companyId);
  if (!c) throw new Error('Company not found');
  db.prepare('UPDATE companies SET next_report_no = next_report_no + 1 WHERE id = ?').run(companyId);
  return `EXP-${new Date().getFullYear()}-${String(c.next_report_no).padStart(4, '0')}`;
});

const COVER = { kind: 'kind', title: 'title', purpose: 'purpose', periodFrom: 'period_from', periodTo: 'period_to', destination: 'destination', nights: 'nights', notes: 'notes' };
const STATE = { status: 'status', submittedAt: 'submitted_at', approvedBy: 'approved_by', approvedAt: 'approved_at', rejectedReason: 'rejected_reason', paidAt: 'paid_at', xeroInvoiceId: 'xero_invoice_id', xeroError: 'xero_error' };

function createReport({ id = newId(), companyId, userId, kind = 'trip', title = null, purpose = null, periodFrom = null, periodTo = null, destination = null, nights = null, advances = 0, notes = null }) {
  const number = nextNumber(companyId);
  db.prepare(`INSERT INTO expense_reports (id, company_id, user_id, number, kind, title, purpose, period_from, period_to, destination, nights, status, advances_cents, notes, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
    .run(id, companyId, userId, number, kind === 'period' ? 'period' : 'trip', title, purpose, periodFrom, periodTo, destination, nights, toCents(advances) || 0, notes, now());
  addEvent(id, userId, 'created', null);
  return getReport(id);
}

function _totals(list) {
  const byCategory = {};
  let baseCents = 0, pendingRates = 0, unreviewed = 0, lineCount = 0;
  for (const e of list) {
    if (e.status !== 'reviewed') unreviewed++;
    if (e.fxPending || !e.lines.length) pendingRates++;
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
  return { totalBase: baseCents / 100, byCategory, pendingRates, unreviewed, expenseCount: list.length, lineCount };
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
      (SELECT COUNT(*) FROM expense_lines l JOIN expenses e ON e.id = l.expense_id WHERE e.report_id = r.id AND l.base_cents IS NULL) AS pending_lines
    FROM expense_reports r JOIN users u ON u.id = r.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC`).all(...args);
  return rows.map(x => ({ ..._row(x), ownerName: x.owner_name, ownerEmail: x.owner_email, expenseCount: x.expense_count, totalBase: toDollars(x.base_cents) ?? 0, pendingRates: x.pending_lines }));
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
const POSTING = 'posting';
function claimForPost(id) {
  const info = db.prepare(`UPDATE expense_reports SET xero_error = ?, updated_at = ?
                           WHERE id = ? AND xero_invoice_id IS NULL AND COALESCE(xero_error, '') != ?`)
    .run(POSTING, now(), id, POSTING);
  return info.changes === 1;
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
  claimForPost, releasePost, createReport, getReport, listReports, updateReport, setState, addExpense, removeExpense, deleteReport, addEvent, listEvents, nextNumber };
