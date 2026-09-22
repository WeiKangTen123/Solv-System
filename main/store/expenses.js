const db = require('../db');
const { newId } = require('../utils/ids');

// Every write to receipts, expenses and expense_lines goes through here. Money
// is cents in SQLite and dollars at this boundary, as in the Xero app's store.
const toCents   = v => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100));
const toDollars = c => (c === null || c === undefined ? null : Math.round(c) / 100);
const now = () => new Date().toISOString();

// ── Receipts ─────────────────────────────────────────────────────────────────
function _receipt(row) {
  if (!row) return null;
  return {
    id: row.id, companyId: row.company_id, userId: row.user_id, file: row.file, mime: row.mime, sizeBytes: row.size_bytes,
    sha256: row.sha256, pages: row.pages, source: row.source, groupId: row.group_id, originalName: row.original_name,
    receivedAt: row.received_at, parsedAt: row.parsed_at,
  };
}

function createReceipt({ id = newId(), companyId, userId, file, mime, sizeBytes = 0, sha256 = null, pages = null, source = 'upload', groupId = null, originalName = null }) {
  db.prepare(`INSERT INTO receipts (id, company_id, user_id, file, mime, size_bytes, sha256, pages, source, group_id, original_name, received_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, companyId, userId, file, mime, sizeBytes, sha256, pages, source, groupId, originalName ? String(originalName).slice(0, 200) : null, now());
  return getReceipt(id);
}
function getReceipt(id) { return _receipt(db.prepare('SELECT * FROM receipts WHERE id = ?').get(id)); }
function findReceiptByHash(companyId, sha256) {
  if (!sha256) return null;
  return _receipt(db.prepare('SELECT * FROM receipts WHERE company_id = ? AND sha256 = ? ORDER BY received_at LIMIT 1').get(companyId, sha256));
}
const RECEIPT_COLS = { pages: 'pages', parsedAt: 'parsed_at', parseJson: 'parse_json', groupId: 'group_id', sha256: 'sha256', file: 'file' };
function updateReceipt(id, patch) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries(RECEIPT_COLS)) {
    if (patch[k] === undefined) continue;
    sets.push(`${col} = ?`); args.push(k === 'parseJson' && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]);
  }
  if (sets.length) db.prepare(`UPDATE receipts SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return getReceipt(id);
}
function deleteReceipt(id) { db.prepare('DELETE FROM receipts WHERE id = ?').run(id); }
function countExpensesForReceipt(receiptId) { return db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE receipt_id = ?').get(receiptId).n; }
function countExpensesForFile(userId, file) {
  return db.prepare('SELECT COUNT(*) AS n FROM expenses e JOIN receipts r ON r.id = e.receipt_id WHERE r.user_id = ? AND r.file = ?').get(userId, file).n;
}

// ── Lines ────────────────────────────────────────────────────────────────────
const FX_DAY_SLACK = 4;   // a long weekend
function _farApart(priced, asked) {
  if (!priced || !asked) return false;
  const gap = (Date.parse(priced) - Date.parse(asked)) / 86400000;
  if (!Number.isFinite(gap)) return false;
  return gap > 0 || gap < -FX_DAY_SLACK;
}

function _line(row) {
  return {
    id: row.id, expenseId: row.expense_id, sortOrder: row.sort_order, category: row.category, description: row.description,
    amount: toDollars(row.amount_cents), currency: row.currency,
    fxRate: row.fx_rate, fxRateDate: row.fx_rate_date, fxSource: row.fx_source, fxFetchedAt: row.fx_fetched_at, fxPolicy: row.fx_policy,
    fxOverrideBy: row.fx_override_by, fxOverrideReason: row.fx_override_reason, baseAmount: toDollars(row.base_cents),
    fxAskedDate: row.fx_asked_date, fxCheck: row.fx_check,
    // A rate priced a long way from the receipt is not the receipt's rate. It
    // happens forwards for the ~130 currencies the ECB does not publish, where
    // the only provider left knows today and nothing else; and backwards when a
    // receipt carries a date in the future, usually a misread year, which used
    // to take today's rate with nothing said. A weekend or a holiday is three
    // days at most, which is what the window allows for.
    fxNotOnTheDay: _farApart(row.fx_rate_date, row.fx_asked_date),
    onBehalfOf: row.on_behalf_of, accountCode: row.account_code,
  };
}
function getLines(expenseId) {
  return db.prepare('SELECT * FROM expense_lines WHERE expense_id = ? ORDER BY sort_order, id').all(expenseId).map(_line);
}
function linesReconcile(lines, totalCents) {
  const sum = (lines || []).reduce((s, l) => s + (toCents(l.amount) || 0), 0);
  return sum === totalCents;
}
// Replaces every line. The lines must sum to the expense total, to the cent —
// that is the whole point of a split — unless `force` says the caller is
// mid-edit and will reconcile later.
function replaceLines(expenseId, lines, { force = false } = {}) {
  const exp = db.prepare('SELECT total_cents, currency FROM expenses WHERE id = ?').get(expenseId);
  if (!exp) throw new Error('Expense not found');
  const list = (lines || []).map(l => ({ ...l, cents: toCents(l.amount) || 0 }));
  const sum = list.reduce((s, l) => s + l.cents, 0);
  if (!force && sum !== exp.total_cents) {
    throw new Error(`Lines total ${(sum / 100).toFixed(2)} but the receipt total is ${(exp.total_cents / 100).toFixed(2)}`);
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM expense_lines WHERE expense_id = ?').run(expenseId);
    const ins = db.prepare(`INSERT INTO expense_lines (expense_id, sort_order, category, description, amount_cents, currency,
      fx_rate, fx_rate_date, fx_source, fx_fetched_at, fx_policy, fx_override_by, fx_override_reason, base_cents, on_behalf_of, account_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    list.forEach((l, i) => ins.run(expenseId, i, l.category || null, l.description ? String(l.description).slice(0, 250) : null, l.cents,
      l.currency || exp.currency || null, l.fxRate ?? null, l.fxRateDate ?? null, l.fxSource ?? null, l.fxFetchedAt ?? null, l.fxPolicy ?? null,
      l.fxOverrideBy ?? null, l.fxOverrideReason ?? null, toCents(l.baseAmount), l.onBehalfOf ? String(l.onBehalfOf).slice(0, 80) : null, l.accountCode ?? null));
  });
  tx();
  return getLines(expenseId);
}
const LINE_COLS = { category: 'category', description: 'description', onBehalfOf: 'on_behalf_of', accountCode: 'account_code',
  fxRate: 'fx_rate', fxRateDate: 'fx_rate_date', fxSource: 'fx_source', fxFetchedAt: 'fx_fetched_at', fxPolicy: 'fx_policy',
  fxOverrideBy: 'fx_override_by', fxOverrideReason: 'fx_override_reason',
  fxAskedDate: 'fx_asked_date', fxCheck: 'fx_check' };
function updateLine(lineId, patch) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries(LINE_COLS)) { if (patch[k] === undefined) continue; sets.push(`${col} = ?`); args.push(patch[k]); }
  if (patch.baseAmount !== undefined) { sets.push('base_cents = ?'); args.push(toCents(patch.baseAmount)); }
  if (sets.length) db.prepare(`UPDATE expense_lines SET ${sets.join(', ')} WHERE id = ?`).run(...args, lineId);
  return _line(db.prepare('SELECT * FROM expense_lines WHERE id = ?').get(lineId));
}

// ── Expenses ─────────────────────────────────────────────────────────────────
const EXPENSE_COLS = {
  receiptId: 'receipt_id', reportId: 'report_id', merchant: 'merchant', receiptDate: 'receipt_date', receiptTime: 'receipt_time',
  invoiceNo: 'invoice_no', currency: 'currency', purpose: 'purpose', description: 'description', category: 'category', status: 'status',
  duplicateOf: 'duplicate_of', errorMsg: 'error_msg', aiReadAt: 'ai_read_at', aiConfidence: 'ai_confidence', page: 'page', source: 'source',
};
const MONEY = { total: 'total_cents', tax: 'tax_cents', subTotal: 'subtotal_cents' };

function _expense(row, lines, receipt) {
  if (!row) return null;
  let box = null;
  try { box = row.box ? JSON.parse(row.box) : null; } catch { box = null; }
  // The base-currency figure is the sum of the lines once every line has one.
  const priced = !!(lines && lines.length) && lines.every(l => l.baseAmount !== null && l.baseAmount !== undefined);
  const baseCents = priced ? lines.reduce((sum, l) => sum + Math.round(l.baseAmount * 100), 0) : null;
  return {
    baseTotal: baseCents === null ? null : baseCents / 100,
    fxPending: !!(lines && lines.length) && !priced,
    id: row.id, companyId: row.company_id, userId: row.user_id, receiptId: row.receipt_id, reportId: row.report_id,
    merchant: row.merchant, receiptDate: row.receipt_date, receiptTime: row.receipt_time, invoiceNo: row.invoice_no, currency: row.currency,
    total: toDollars(row.total_cents) ?? 0, tax: toDollars(row.tax_cents), subTotal: toDollars(row.subtotal_cents),
    purpose: row.purpose, description: row.description, category: row.category, status: row.status, duplicateOf: row.duplicate_of,
    errorMsg: row.error_msg, aiReadAt: row.ai_read_at, aiConfidence: row.ai_confidence, box, page: row.page, source: row.source,
    createdAt: row.created_at, updatedAt: row.updated_at, lines: lines || [], receipt: receipt || null,
  };
}
function _hydrate(row) {
  if (!row) return null;
  return _expense(row, getLines(row.id), row.receipt_id ? getReceipt(row.receipt_id) : null);
}

function createExpense({ id = newId(), companyId, userId, lines = [], box = null, ...fields }) {
  const cols = ['id', 'company_id', 'user_id', 'created_at', 'box'];
  const vals = [id, companyId, userId, now(), box ? JSON.stringify(box) : null];
  for (const [k, col] of Object.entries(EXPENSE_COLS)) { if (fields[k] === undefined) continue; cols.push(col); vals.push(fields[k]); }
  for (const [k, col] of Object.entries(MONEY)) { if (fields[k] === undefined) continue; cols.push(col); vals.push(toCents(fields[k])); }
  if (!cols.includes('status')) { cols.push('status'); vals.push('reading'); }
  db.prepare(`INSERT INTO expenses (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  if (lines.length) replaceLines(id, lines, { force: true });
  return getExpense(id);
}
function getExpense(id) { return _hydrate(db.prepare('SELECT * FROM expenses WHERE id = ?').get(id)); }

function updateExpense(id, patch) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries(EXPENSE_COLS)) { if (patch[k] === undefined) continue; sets.push(`${col} = ?`); args.push(patch[k]); }
  for (const [k, col] of Object.entries(MONEY)) { if (patch[k] === undefined) continue; sets.push(`${col} = ?`); args.push(toCents(patch[k]) ?? (k === 'total' ? 0 : null)); }
  if (patch.box !== undefined) { sets.push('box = ?'); args.push(patch.box ? JSON.stringify(patch.box) : null); }
  sets.push('updated_at = ?'); args.push(now());
  db.prepare(`UPDATE expenses SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return getExpense(id);
}

function listExpenses({ companyId, userId, status, reportId, unfiled, from, to, receiptId, groupId } = {}) {
  const where = [], args = [];
  if (companyId) { where.push('e.company_id = ?'); args.push(companyId); }
  if (userId)    { where.push('e.user_id = ?'); args.push(userId); }
  if (status)    { where.push('e.status = ?'); args.push(status); }
  if (reportId)  { where.push('e.report_id = ?'); args.push(reportId); }
  if (unfiled)   { where.push('e.report_id IS NULL'); }
  if (from)      { where.push('e.receipt_date >= ?'); args.push(from); }
  if (to)        { where.push('e.receipt_date <= ?'); args.push(to); }
  if (receiptId) { where.push('e.receipt_id = ?'); args.push(receiptId); }
  if (groupId)   { where.push('e.receipt_id IN (SELECT id FROM receipts WHERE group_id = ?)'); args.push(groupId); }
  const sql = `SELECT e.* FROM expenses e ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.receipt_date DESC, e.created_at DESC`;
  return db.prepare(sql).all(...args).map(_hydrate);
}
function expensesForReceipt(receiptId) { return listExpenses({ receiptId }); }
function deleteExpense(id) { db.prepare('DELETE FROM expenses WHERE id = ?').run(id); }

// The shape intake/dedup.js reads: vendorName, invoiceDate, totalAmount, status,
// plus findByReceiptHash. Scoped to the company so one person's duplicate of a
// colleague's receipt (the same folio uploaded by both) is caught too.
function dedupView(companyId) {
  const shape = e => e && ({ id: e.id, vendorName: e.merchant, invoiceDate: e.receiptDate, totalAmount: e.total, status: e.status, invoiceNumber: e.invoiceNo,
                             receiptFile: e.receipt && e.receipt.file, receiptMime: e.receipt && e.receipt.mime, receiptId: e.receiptId, userId: e.userId });
  return {
    findByReceiptHash(hash) {
      const r = findReceiptByHash(companyId, hash);
      if (!r) return null;
      const e = db.prepare('SELECT * FROM expenses WHERE receipt_id = ? ORDER BY created_at LIMIT 1').get(r.id);
      return e ? shape(_hydrate(e)) : { id: null, receiptId: r.id, receiptFile: r.file, receiptMime: r.mime, userId: r.userId };
    },
    getAll() { return listExpenses({ companyId }).map(shape); },
  };
}

module.exports = {
  createReceipt, getReceipt, findReceiptByHash, updateReceipt, deleteReceipt, countExpensesForReceipt, countExpensesForFile,
  createExpense, getExpense, updateExpense, listExpenses, expensesForReceipt, deleteExpense,
  getLines, replaceLines, updateLine, linesReconcile, dedupView, toCents, toDollars,
};
