const db = require('../db');
const { newId } = require('../utils/ids');
const { localDate } = require('../utils/zone-date');
const expenses = require('./expenses');

// Expense reports: the cover, the workflow state and the audit trail. Lines
// and money live on the expenses; a report is a grouping with totals.
const now = () => new Date().toISOString();
const toCents = expenses.toCents, toDollars = expenses.toDollars;

// The cover fields the AI may fill, and the ones cover_ai keeps track of.
// `auto` are the fields whose current value the AI wrote (the page marks
// them); `user` are those the owner set, which the AI never writes again.
const AI_FIELDS = ['kind', 'title', 'purpose', 'periodFrom', 'periodTo', 'destination', 'nights'];
// A column written by hand or by an older build may hold anything; a cover
// that cannot be read is one nobody has marked yet, not an error.
function _coverAi(raw) {
  let v = null;
  try { v = raw ? JSON.parse(raw) : null; } catch { v = null; }
  const list = x => (Array.isArray(x) ? [...new Set(x.filter(f => AI_FIELDS.includes(f)))] : []);
  return { auto: list(v && v.auto), user: list(v && v.user) };
}

function _row(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, userId: r.user_id, number: r.number, kind: r.kind, title: r.title, purpose: r.purpose,
    periodFrom: r.period_from, periodTo: r.period_to, destination: r.destination, nights: r.nights, status: r.status,
    advances: toDollars(r.advances_cents) ?? 0, claimedAt: r.claimed_at, xeroInvoiceId: r.xero_invoice_id, xeroError: r.xero_error, notes: r.notes,
    coverAi: _coverAi(r.cover_ai), createdAt: r.created_at, updatedAt: r.updated_at,
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

const _filled = v => v !== null && v !== undefined && v !== '';

// The number, the case and its first event together: a failure part-way used
// to spend a case number on a case that did not exist.
//
// A draft is the case a first receipt lands in before its owner has said
// what it is. It has no number until it is opened (openDraft), so the drafts
// people abandon leave no gaps in the numbering.
//
// Whatever cover the caller gave is the person's (cover_ai.user), so the AI
// filling in a draft never writes over it. The kind defaults to 'case', the
// one that claims nothing about the receipts.
function createReport(args) {
  return db.transaction(_createReport)(args);
}
function _createReport({ id = newId(), companyId, userId, draft = false, kind, title = null, purpose = null, periodFrom = null, periodTo = null, destination = null, nights = null, advances = 0, notes = null }) {
  const given = { kind, title, purpose, periodFrom, periodTo, destination, nights };
  const coverAi = { auto: [], user: AI_FIELDS.filter(f => _filled(given[f])) };
  const number = draft ? null : nextNumber(companyId);
  db.prepare(`INSERT INTO expense_reports (id, company_id, user_id, number, kind, title, purpose, period_from, period_to, destination, nights, status, advances_cents, notes, cover_ai, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, companyId, userId, number, KINDS.has(kind) ? kind : 'case', title, purpose, periodFrom, periodTo, destination, nights,
         draft ? 'draft' : 'open', toCents(advances) || 0, notes, JSON.stringify(coverAi), now());
  addEvent(id, userId, 'created', draft ? 'draft' : null);
  return getReport(id);
}

// "Receipts, 21 Oct 2026": what a draft is called when its owner creates it
// before anything in it has been read well enough to suggest a name.
function _fallbackTitle(timezone) {
  const day = localDate(timezone);
  return `Receipts, ${require('../reports/cover-suggest').dayRange(day, day)}`;
}

// A draft becomes a case: whatever the owner sent with it is saved first and
// is theirs, a missing title is filled from what the receipts suggest, and
// only then is a number taken. All of it or none of it, so a failure cannot
// spend a number on a case still a draft, or open one without a number.
// Returns null when it is not a draft (any more): two clicks on Create case
// open it once.
function openDraft(id, patch = {}, actorId = null) {
  return db.transaction(() => {
    const r = db.prepare('SELECT company_id, status FROM expense_reports WHERE id = ?').get(id);
    if (!r || r.status !== 'draft') return null;
    if (Object.keys(patch).length) _saveCover(id, patch, { by: 'user' });
    const cur = getReport(id);
    if (!cur.title) {
      const company = db.prepare('SELECT base_currency, timezone FROM companies WHERE id = ?').get(r.company_id) || {};
      const { suggestCover } = require('../reports/cover-suggest');
      const s = suggestCover(cur.expenses, { baseCurrency: company.base_currency || 'SGD', today: localDate(company.timezone) });
      const ai = cur.coverAi;
      _saveCover(id, { title: (s && s.title) || _fallbackTitle(company.timezone) }, { by: 'auto' });
      setCoverAi(id, { auto: [...new Set([...ai.auto, 'title'])], user: ai.user.filter(f => f !== 'title') });
    }
    const number = nextNumber(r.company_id);
    db.prepare("UPDATE expense_reports SET number = ?, status = 'open', updated_at = ? WHERE id = ? AND status = 'draft'").run(number, now(), id);
    addEvent(id, actorId, 'opened', null);
    return getReport(id);
  })();
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

// The cases list. The scope (a company, a person, a list of people, and an
// admin's choice of owner) decides which cases are counted at all; the rest
// (status, kind, ready, posted, q) only narrows what is shown, and `counts`
// ignores it, so the tabs say how many each holds whichever one is open.
//
// One query reads the scope's cases with their sums, and the filtering,
// sorting and paging happen here. The counts need "ready" for every case in
// the scope anyway, which is the expensive part, so asking SQL for a page
// as well would have read the same cases twice.
//
// Without a limit every case comes back, as before; Home asks for them all.
const SORTS = {
  newest: (a, b) => _cmp(b.createdAt, a.createdAt),
  oldest: (a, b) => _cmp(a.createdAt, b.createdAt),
  amount: (a, b) => b.totalBase - a.totalBase || _cmp(b.createdAt, a.createdAt),
  // Most recent trip first; a case with no dates after every one that has.
  dates:  (a, b) => (a.periodFrom ? 0 : 1) - (b.periodFrom ? 0 : 1) || _cmp(b.periodFrom || '', a.periodFrom || '') || _cmp(b.createdAt, a.createdAt),
};
const _cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const _list = v => (v === undefined || v === null || v === '' ? null : (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean));
// A LIKE pattern that matches what was typed, "%" and "_" included.
const _like = q => `%${String(q).replace(/[\\%_]/g, c => `\\${c}`)}%`;

function listReports({ companyId, userId, userIds, owner, status, kind, q, ready, posted, sort = 'newest', limit, offset = 0 } = {}) {
  const where = [], args = [];
  if (companyId) { where.push('r.company_id = ?'); args.push(companyId); }
  if (userId)    { where.push('r.user_id = ?'); args.push(userId); }
  if (owner)     { where.push('r.user_id = ?'); args.push(owner); }
  if (userIds)   {
    if (!userIds.length) return { rows: [], total: 0, counts: { draft: 0, open: 0, ready: 0, claimed: 0, all: 0 } };
    where.push(`r.user_id IN (${userIds.map(() => '?').join(',')})`); args.push(...userIds);
  }
  const text = q === undefined || q === null ? '' : String(q).trim();
  // Whether each case matches the search, asked in the same query: the title,
  // number, purpose and destination, or the merchant of any receipt in it.
  const hit = text
    ? `(r.title LIKE ? ESCAPE '\\' OR r.number LIKE ? ESCAPE '\\' OR r.purpose LIKE ? ESCAPE '\\' OR r.destination LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM expenses e WHERE e.report_id = r.id AND e.merchant LIKE ? ESCAPE '\\'))`
    : '1';
  const hitArgs = text ? Array(5).fill(_like(text)) : [];
  const rows = db.prepare(`
    SELECT r.*, u.name AS owner_name, u.email AS owner_email, ${hit} AS q_hit,
      (SELECT COUNT(*) FROM expenses e WHERE e.report_id = r.id) AS expense_count,
      (SELECT SUM(l.base_cents) FROM expense_lines l JOIN expenses e ON e.id = l.expense_id WHERE e.report_id = r.id) AS base_cents,
      -- Receipts waiting for a rate, and receipts with no amount yet, as the
      -- case page counts them: one with three unpriced lines is one receipt
      -- waiting, not three.
      (SELECT COUNT(*) FROM expenses e WHERE e.report_id = r.id
         AND EXISTS (SELECT 1 FROM expense_lines l WHERE l.expense_id = e.id AND l.base_cents IS NULL)) AS pending_lines,
      (SELECT COUNT(*) FROM expenses e WHERE e.report_id = r.id
         AND NOT EXISTS (SELECT 1 FROM expense_lines l WHERE l.expense_id = e.id)) AS no_amount,
      (SELECT COUNT(*) FROM expenses e WHERE e.report_id = r.id AND e.status != 'reviewed') AS unreviewed,
      (SELECT COUNT(*) FROM expenses e WHERE e.report_id = r.id AND e.status = 'reading') AS reading
    FROM expense_reports r JOIN users u ON u.id = r.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC, r.id DESC`).all(...hitArgs, ...args);
  const all = rows.map(x => ({
    ..._row(x), ownerName: x.owner_name, ownerEmail: x.owner_email, expenseCount: x.expense_count, totalBase: toDollars(x.base_cents) ?? 0,
    pendingRates: x.pending_lines, noAmount: x.no_amount, unreviewed: x.unreviewed, reading: x.reading,
    // Ready to claim: open, something in it, and nothing unchecked, unpriced
    // or without an amount — the checks claiming makes (reports/workflow.js).
    ready: x.status === 'open' && x.expense_count > 0 && !x.unreviewed && !x.pending_lines && !x.no_amount,
    _hit: !!x.q_hit,
  }));
  const counts = { draft: 0, open: 0, ready: 0, claimed: 0, all: all.length };
  for (const r of all) { if (counts[r.status] !== undefined) counts[r.status]++; if (r.ready) counts.ready++; }

  const statuses = _list(status), kinds = _list(kind);
  const isPosted = posted === undefined || posted === null || posted === '' ? null : posted === true || String(posted) === '1';
  const wantReady = ready === true || String(ready) === '1';
  const shown = all.filter(r => (!statuses || statuses.includes(r.status)) && (!kinds || kinds.includes(r.kind))
    && (!wantReady || r.ready) && (isPosted === null || !!r.xeroInvoiceId === isPosted) && r._hit)
    .sort(SORTS[sort] || SORTS.newest);
  for (const r of all) delete r._hit;
  const start = Math.max(0, Number(offset) || 0);
  const page = limit === undefined || limit === null ? shown.slice(start) : shown.slice(start, start + Math.max(0, Number(limit) || 0));
  return { rows: page, total: shown.length, counts };
}

// The owner's edit of the cover. Every cover field in it becomes theirs: the
// AI fills a draft as its receipts are read, and must not then change a
// title somebody typed, or put back a destination somebody cleared.
//
// What changed goes in the case's history as `details_edited`, one event per
// stretch of editing (noteDetailsEdited). Only the cover's owner edits it,
// here or through the assistant on their behalf, so the owner is the actor
// when the caller does not say; `via: 'assistant'` says it was the
// assistant's proposal they applied. A draft writes none: its details are
// being put together, and "Created" is the event that stands for them.
// The AI's own writes go through applyAutoCover and are not edits by anyone.
function updateReport(id, patch, { actorId = null, via = 'app' } = {}) {
  db.transaction(() => {
    const before = db.prepare('SELECT * FROM expense_reports WHERE id = ?').get(id);
    _saveCover(id, patch, { by: 'user' });
    if (!before || before.status === 'draft') return;
    const after = db.prepare('SELECT * FROM expense_reports WHERE id = ?').get(id);
    const fields = DETAIL_FIELDS.filter(([, cols]) => cols.some(c => (before[c] ?? null) !== (after[c] ?? null))).map(([label]) => label);
    if (fields.length) noteDetailsEdited(id, actorId || before.user_id, fields, via);
  })();
  return getReport(id);
}
// The cover's fields as the history names them, in the order they are listed:
// the two dates are one thing to a person, "the dates".
const DETAIL_FIELDS = [
  ['kind', ['kind']], ['title', ['title']], ['dates', ['period_from', 'period_to']], ['destination', ['destination']],
  ['nights', ['nights']], ['purpose', ['purpose']], ['advances', ['advances_cents']], ['notes', ['notes']],
];
const DETAIL_ORDER = DETAIL_FIELDS.map(([label]) => label);
const VIA_ASSISTANT = ' (via the assistant)';
// `by: 'user'` moves the fields to cover_ai.user and out of auto; `by: 'auto'`
// leaves cover_ai to the caller (reports/cover-auto.js keeps it itself).
function _saveCover(id, patch, { by = 'user' } = {}) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries(COVER)) { if (patch[k] === undefined) continue; sets.push(`${col} = ?`); args.push(patch[k] === '' ? null : patch[k]); }
  if (patch.advances !== undefined) { sets.push('advances_cents = ?'); args.push(toCents(patch.advances) || 0); }
  if (by === 'user') {
    const mine = AI_FIELDS.filter(f => patch[f] !== undefined);
    if (mine.length) {
      const ai = _coverAi((db.prepare('SELECT cover_ai FROM expense_reports WHERE id = ?').get(id) || {}).cover_ai);
      sets.push('cover_ai = ?');
      args.push(JSON.stringify({ auto: ai.auto.filter(f => !mine.includes(f)), user: [...new Set([...ai.user, ...mine])] }));
    }
  }
  sets.push('updated_at = ?'); args.push(now());
  db.prepare(`UPDATE expense_reports SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
}

// Which cover fields the AI wrote and which are the owner's, replaced whole.
function setCoverAi(id, coverAi) {
  const v = _coverAi(JSON.stringify(coverAi || {}));
  db.prepare('UPDATE expense_reports SET cover_ai = ? WHERE id = ?').run(JSON.stringify(v), id);
}

// The AI's cover, written with the record of which fields it now holds, and
// nothing else: no event, and no field outside what the caller worked out
// (reports/cover-auto.js decides which fields it may touch).
function applyAutoCover(id, patch, coverAi) {
  db.transaction(() => {
    if (Object.keys(patch).length) _saveCover(id, patch, { by: 'auto' });
    setCoverAi(id, coverAi);
  })();
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

// Two cases that turned out to be one: every receipt of the source moves to
// the target, the target's history says where they came from, and the source
// goes. One transaction, so a failure cannot leave the receipts split between
// a case that is gone and one that does not say it took them. Who may, and
// which states allow it, is the route's question (routes/reports.js).
// Returns how many receipts moved.
function mergeInto(sourceId, targetId, actorId = null) {
  return db.transaction(() => {
    const src = db.prepare('SELECT number, title FROM expense_reports WHERE id = ?').get(sourceId);
    if (!src || sourceId === targetId) return 0;
    const moved = db.prepare('UPDATE expenses SET report_id = ?, updated_at = ? WHERE report_id = ?').run(targetId, now(), sourceId).changes;
    const name = src.number ? `${src.number}${src.title ? ` (${src.title})` : ''}` : src.title ? `the draft "${src.title}"` : 'a draft';
    addEvent(targetId, actorId, 'edited', `Merged ${moved} receipt${moved === 1 ? '' : 's'} from ${name}`);
    db.prepare('UPDATE expense_reports SET updated_at = ? WHERE id = ?').run(now(), targetId);
    // A phone still pointed at the case being merged away keeps sending its
    // photos to where that case's receipts went, rather than to no case at
    // all once the foreign key empties it.
    db.prepare('UPDATE phone_pairings SET report_id = ? WHERE report_id = ?').run(targetId, sourceId);
    deleteReport(sourceId);
    return moved;
  })();
}

function addEvent(reportId, actorId, action, note = null) {
  db.prepare('INSERT INTO report_events (report_id, actor_id, action, note, at) VALUES (?, ?, ?, ?, ?)').run(reportId, actorId || null, action, note, now());
}

// One event for a stretch of the same thing done by the same person: the
// cover saves 600 ms after each key, and a person checks thirty receipts one
// at a time, and a history of every keystroke and every click says nothing.
//
// The case's latest event is brought up to date instead of a new one written
// when it is the same action by the same person and they did it last within
// COALESCE_MS; its time moves to now, so it sits where the person stopped.
// Only the latest: anything in between (a claim, the AI changing the dates)
// starts a new one, so the history never shows a stretch spanning something
// that happened in its middle.
//
// `merge(prev)` is given the event being continued (or null) and returns its
// note, or undefined when the two cannot be one event after all.
const COALESCE_MS = 15 * 60 * 1000;
function coalesceEvent(reportId, actorId, action, merge) {
  return db.transaction(() => {
    const last = db.prepare('SELECT * FROM report_events WHERE report_id = ? ORDER BY id DESC LIMIT 1').get(reportId);
    const at = now();
    if (last && last.action === action && (last.actor_id || null) === (actorId || null) && Date.parse(last.at) >= Date.parse(at) - COALESCE_MS) {
      const note = merge(last);
      if (note !== undefined) {
        db.prepare('UPDATE report_events SET note = ?, at = ? WHERE id = ?').run(note, at, last.id);
        return last.id;
      }
    }
    return db.prepare('INSERT INTO report_events (report_id, actor_id, action, note, at) VALUES (?, ?, ?, ?, ?)')
      .run(reportId, actorId || null, action, merge(null), at).lastInsertRowid;
  })();
}

// "title, dates": the fields edited in this stretch, each once, in the
// cover's order. Edits through the assistant are a stretch of their own, so
// the history can say whose proposal it was.
function noteDetailsEdited(reportId, actorId, fields, via = 'app') {
  const tail = via === 'assistant' ? VIA_ASSISTANT : '';
  return coalesceEvent(reportId, actorId, 'details_edited', prev => {
    let had = [];
    if (prev) {
      const note = String(prev.note || '');
      if (note.endsWith(VIA_ASSISTANT) !== !!tail) return undefined;
      had = note.slice(0, note.length - tail.length).split(', ');
    }
    return DETAIL_ORDER.filter(f => had.includes(f) || fields.includes(f)).join(', ') + tail;
  });
}

// A receipt checked on its own, from any page: "3 receipts" for the run.
// The count is of the receipts checked in the run (store/changes.js), not of
// clicks, so one checked, unchecked and checked again is one. "Check all"
// writes its own event (routes/reports.js review-all), which a check straight
// after it continues.
function noteChecked(reportId, actorId) {
  const changes = require('./changes');
  const _n = n => `${n} receipt${n === 1 ? '' : 's'}`;
  return coalesceEvent(reportId, actorId, 'checked', prev => {
    if (!prev) return _n(1);
    // The run started after whatever the case's history said before it.
    const before = db.prepare('SELECT at FROM report_events WHERE report_id = ? AND id < ? ORDER BY id DESC LIMIT 1').get(reportId, prev.id);
    const run = changes.checkRun(changes.checksInCase(reportId, actorId, before ? before.at : ''));
    const had = Number((String(prev.note || '').match(/^(\d+) receipts?$/) || [])[1]) || 0;
    return _n(Math.max(new Set(run.map(c => c.expenseId)).size, had, 1));
  });
}
function listEvents(reportId) {
  return db.prepare('SELECT ev.*, u.name AS actor_name, u.email AS actor_email FROM report_events ev LEFT JOIN users u ON u.id = ev.actor_id WHERE ev.report_id = ? ORDER BY ev.id').all(reportId)
    .map(x => ({ id: x.id, action: x.action, note: x.note, at: x.at, actorId: x.actor_id, actorName: x.actor_name || x.actor_email || null }));
}

module.exports = {
  claimForPost, releasePost, isPosting, recordBill, POST_STALE_MS, createReport, openDraft, getReport, head, listReports, updateReport, setCoverAi, applyAutoCover,
  setState, addExpense, removeExpense, deleteReport, mergeInto, addEvent, coalesceEvent, noteDetailsEdited, noteChecked, listEvents, nextNumber,
  AI_FIELDS, SORTS, COALESCE_MS };
