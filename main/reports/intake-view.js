const db = require('../db');
const readQueue = require('../receipts/read-queue');
const { flagsFor } = require('../receipts/flags');
const { suggestCover, findMatch } = require('./cover-suggest');

// What the New case page and the case page poll while receipts go in: one row
// per file the person sent, how far its read has got, and what came out of it.
// A file is the unit the person handed over, so it is the unit they watch; the
// receipts a folio or a photo of three splits into hang under it.
//
// Built from the case the route already loaded, plus the read jobs in one
// query, so a poll every two seconds costs a page of a few receipts, not one
// query per row.

// Seconds a read usually takes here, from the company's last twenty finished
// reads; a new system has none and gets a fair guess.
const GUESS_SECONDS = 8;
function _averageReadSeconds(companyId) {
  const row = db.prepare(`SELECT AVG((julianday(finished_at) - julianday(started_at)) * 86400) AS s FROM (
                            SELECT started_at, finished_at FROM read_jobs
                            WHERE company_id = ? AND state = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL
                            ORDER BY finished_at DESC LIMIT 20)`).get(companyId);
  const s = row && Number(row.s);
  return Number.isFinite(s) && s > 0 ? s : GUESS_SECONDS;
}

function _expenseSummary(e, report, ctx) {
  return {
    id: e.id, status: e.status, merchant: e.merchant, receiptDate: e.receiptDate, currency: e.currency,
    total: e.total, baseTotal: e.baseTotal, category: e.category, city: e.city || null, country: e.country || null,
    docType: e.docType || null, flags: e.flags || flagsFor(e, report, ctx), errorMsg: e.errorMsg || null,
  };
}

function intakeView(report, { baseCurrency, today }) {
  const ctx = { baseCurrency, today };
  const byReceipt = new Map();
  const loose = [];
  for (const e of report.expenses) {
    if (!e.receiptId) { loose.push(e); continue; }
    if (!byReceipt.has(e.receiptId)) byReceipt.set(e.receiptId, { receipt: e.receipt, expenses: [] });
    byReceipt.get(e.receiptId).expenses.push(e);
  }
  const states = readQueue.statesFor([...byReceipt.keys()]);
  const files = [...byReceipt.entries()].map(([receiptId, { receipt, expenses }]) => {
    const read = states.get(receiptId) || null;
    return {
      receiptId,
      originalName: receipt ? receipt.originalName : null,
      mime: receipt ? receipt.mime : null,
      convertedFrom: receipt ? receipt.convertedFrom || null : null,
      sizeBytes: receipt ? receipt.sizeBytes : null,
      receivedAt: receipt ? receipt.receivedAt : null,
      read,
      expenses: expenses.map(e => _expenseSummary(e, report, ctx)),
    };
  }).sort((a, b) => String(a.receivedAt || '').localeCompare(String(b.receivedAt || '')));

  const counts = { files: files.length, queued: 0, reading: 0, done: 0, failed: 0, receipts: report.expenses.length, toCheck: 0 };
  for (const f of files) {
    const s = f.read ? f.read.state : 'done';
    if (s === 'queued') counts.queued++;
    else if (s === 'reading') counts.reading++;
    else if (s === 'failed') counts.failed++;
    else counts.done++;
  }
  counts.toCheck = report.expenses.filter(e => e.status === 'review-needed').length;

  // Reads run READ_PER_USER at a time for one person, so the wait is the
  // queue divided by that, at the pace reads have been going.
  const pending = counts.queued + counts.reading;
  const perUser = Math.max(1, Number(process.env.READ_PER_USER) || 2);
  const etaSeconds = pending ? Math.round(Math.ceil(pending / perUser) * _averageReadSeconds(report.companyId)) : 0;

  return {
    caseId: report.id, status: report.status, number: report.number || null,
    counts, etaSeconds, files,
    loose: loose.map(e => _expenseSummary(e, report, ctx)),
    // The cover as it stands, so the page polling this shows the AI's latest
    // title and dates without asking for the whole case as well.
    cover: { kind: report.kind, title: report.title, purpose: report.purpose, periodFrom: report.periodFrom, periodTo: report.periodTo,
             destination: report.destination, nights: report.nights, advances: report.advances, notes: report.notes },
    totals: report.totals || null,
    coverAi: report.coverAi || { auto: [], user: [] },
    suggestion: suggestCover(report.expenses, ctx),
    match: report.status === 'draft' ? findMatch(report.id, report.userId) : null,
  };
}

module.exports = { intakeView, GUESS_SECONDS };
