const reports = require('../store/reports');
const users   = require('../store/users');
const receiptStore = require('../receipts/receipt-store');
const pdfRender = require('../pdf/render');
const { flagsFor } = require('../receipts/flags');
const { localDate } = require('../utils/zone-date');
const { taxSaid } = require('./expense-doc');
const logger = require('../utils/logger');

const cents = n => Math.round(Number(n || 0) * 100);

// One line's taxes as its receipt printed them, each also in the base
// currency at the line's own rate (null while the line has none). The line's
// `tax` and `baseTax` are their sums, so what reads only those two still
// adds up to what was printed. `gross` is the part of the line's amount the
// tax was charged on, tax included, which is what Xero takes as an inclusive
// line (xero/bills.js).
function printedTaxes(list, currency, rate) {
  const taxes = list.map(t => {
    const amount = cents(t.amount) / 100;
    const gross = t.gross === null || t.gross === undefined ? null : cents(t.gross) / 100;
    return { label: t.label || null, rate: t.rate ?? null, amount, included: !!t.included, gross, ...(t.worked ? { worked: true } : {}),
      baseAmount: rate ? Math.round(cents(amount) * rate) / 100 : null,
      baseGross: rate && gross !== null ? Math.round(cents(gross) * rate) / 100 : null };
  });
  return {
    taxes,
    tax: taxes.reduce((s, t) => s + cents(t.amount), 0) / 100,
    baseTax: rate ? taxes.reduce((s, t) => s + cents(t.baseAmount), 0) / 100 : null,
    taxText: taxes.length ? taxes.map(t => taxSaid(t, currency)).join('; ') : null,
  };
}

// Receipt pages as JPEG data URIs for a portrait A4 page. sharp is loaded
// lazily, as in the thumbnailer, so a missing native module degrades to "no
// image" rather than a failed export.
//
// A transparent PNG is laid on white first: JPEG has no transparency, and
// sharp turned every see-through pixel black, so a cut-out receipt printed as
// a black rectangle with the text lost in it. A PDF receipt is drawn at 140
// dpi, which is about what the page prints it at; 110 left a folio's small
// print unreadable once it filled a portrait page.
async function _pagesFor(receipt) {
  const files = receiptStore.forUser(receipt.userId);
  const buffer = files.read(receipt.file);
  if (!buffer) return [];
  const out = [];
  try {
    if (receipt.mime === 'application/pdf') {
      const rendered = await pdfRender.renderPdfPages(buffer, { dpi: 140, maxPages: 10 });
      for (const p of (rendered ? rendered.pages : [])) out.push({ dataUri: `data:image/jpeg;base64,${p.buffer.toString('base64')}` });
    } else {
      const sharp = require('sharp');
      const jpg = await sharp(buffer).rotate().flatten({ background: '#ffffff' })
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      out.push({ dataUri: `data:image/jpeg;base64,${jpg.toString('base64')}` });
    }
  } catch (err) {
    logger.warn('Receipt page not rendered for the export', { receipt: receipt.id, error: err.message });
  }
  return out;
}

// What the PDF says is worth a second look, per receipt: the same flags the
// case page shows (receipts/flags.js). Dated as of the claim for a claimed
// case: "more than 90 days old" is about when it was claimed, not about the
// day somebody printed it.
function _flags(report, company) {
  const tz = company.timezone || 'Asia/Singapore';
  const today = report.claimedAt ? localDate(tz, new Date(report.claimedAt)) : localDate(tz);
  const out = {};
  for (const e of report.expenses) {
    let list = [];
    try { list = flagsFor(e, report, { baseCurrency: company.baseCurrency, today }); }
    catch (err) { logger.warn('Flags not worked out for the export', { expense: e.id, error: err.message }); }
    if (list.length) out[e.id] = list.map(f => ({ level: f.level, code: f.code, text: f.text }));
  }
  return out;
}

// Everything an export needs, gathered once. Lines are flattened from the
// report's expenses; each receipt file gets one R-number, in report order.
async function reportPayload(reportId, { withReceipts = true } = {}) {
  const report = reports.getReport(reportId);
  if (!report) return null;
  const company = users.getCompany(report.companyId);
  const owner = users.findById(report.userId) || {};

  const refs = receiptRefs(report.expenses); const receipts = []; const lines = [];
  const listed = new Set();
  for (const e of report.expenses) {
    let ref = null;
    if (e.receipt) {
      ref = refs.get(e.receipt.id);
      if (!listed.has(e.receipt.id)) {
        listed.add(e.receipt.id);
        receipts.push({ ref, title: e.merchant || e.receipt.originalName || 'Receipt', date: e.receiptDate || null, receipt: e.receipt, pages: [] });
      }
    }
    // A receipt kept as printed gives each line its own taxes (line.taxes,
    // receipts/printed.js): the Service Tax on a KL hotel's room and the SST
    // on its restaurant stay two taxes at their own rates, on the lines they
    // were charged on. An older receipt has only the one tax figure, and that
    // belongs to the receipt, not to each of its lines. It used to be copied
    // whole onto every line, so a folio split into four categories looked like
    // it carried four times the GST it printed. It is split in proportion to
    // the amounts instead, with the last line taking the rounding residual so
    // the parts still add up to what was printed.
    const kept = e.lines.some(l => Array.isArray(l.taxes));
    const taxCents = kept ? 0 : Math.round(Number(e.tax || 0) * 100);
    const lineCents = e.lines.map(l => Math.round(Number(l.amount || 0) * 100));
    const totalCents = lineCents.reduce((a, b) => a + b, 0);
    let spread = 0;
    e.lines.forEach((l, i) => {
      const currency = l.currency || e.currency;
      const rate = Number(l.fxRate) > 0 ? Number(l.fxRate) : null;
      const line = { ref, expenseId: e.id, source: e.source || null, date: e.receiptDate, merchant: e.merchant, purpose: e.purpose, description: l.description, category: l.category, currency, amount: l.amount,
        fxRate: l.fxRate, fxRateDate: l.fxRateDate, fxSource: l.fxSource, fxFetchedAt: l.fxFetchedAt, fxOverrideBy: l.fxOverrideBy, fxOverrideReason: l.fxOverrideReason,
        fxAskedDate: l.fxAskedDate, fxNotOnTheDay: l.fxNotOnTheDay,
        baseAmount: l.baseAmount, onBehalfOf: l.onBehalfOf };
      if (kept) {
        Object.assign(line, printedTaxes(Array.isArray(l.taxes) ? l.taxes : [], currency, rate || (currency === company.baseCurrency ? 1 : null)));
      } else {
        const share = !taxCents || !totalCents ? 0
          : i === e.lines.length - 1 ? taxCents - spread
          : Math.round(taxCents * lineCents[i] / totalCents);
        spread += share;
        Object.assign(line, { taxes: null, tax: Math.round(share) / 100,
          baseTax: rate ? Math.round(share * rate) / 100 : Math.round(share) / 100,
          taxText: share ? taxSaid(null, currency, share / 100) : null });
      }
      lines.push(line);
    });
  }
  if (withReceipts) for (const r of receipts) r.pages = await _pagesFor(r.receipt);
  for (const r of receipts) delete r.receipt;
  return { company, report, owner, lines, receipts, flags: _flags(report, company), generatedAt: Date.now() };
}

// R1, R2… for each receipt file, in the case's order, first appearance first.
// The printed report and the Xero attachments number them the same way.
function receiptRefs(expenses) {
  const refs = new Map();
  for (const e of expenses || []) if (e.receipt && !refs.has(e.receipt.id)) refs.set(e.receipt.id, `R${refs.size + 1}`);
  return refs;
}

module.exports = { reportPayload, receiptRefs };
