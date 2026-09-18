const reports = require('../store/reports');
const users   = require('../store/users');
const receiptStore = require('../receipts/receipt-store');
const pdfRender = require('../pdf/render');
const logger = require('../utils/logger');

// Receipt pages as JPEG data URIs sized for a landscape A4 page. sharp is
// loaded lazily, as in the thumbnailer, so a missing native module degrades
// to "no image" rather than a failed export.
async function _pagesFor(receipt) {
  const files = receiptStore.forUser(receipt.userId);
  const buffer = files.read(receipt.file);
  if (!buffer) return [];
  const out = [];
  try {
    if (receipt.mime === 'application/pdf') {
      const rendered = await pdfRender.renderPdfPages(buffer, { dpi: 110, maxPages: 10 });
      for (const p of (rendered ? rendered.pages : [])) out.push({ dataUri: `data:image/jpeg;base64,${p.buffer.toString('base64')}` });
    } else {
      const sharp = require('sharp');
      const jpg = await sharp(buffer).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
      out.push({ dataUri: `data:image/jpeg;base64,${jpg.toString('base64')}` });
    }
  } catch (err) {
    logger.warn('Receipt page not rendered for the export', { receipt: receipt.id, error: err.message });
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
  const manager = owner.managerId ? (users.findById(owner.managerId) || {}) : {};
  const approver = report.approvedBy ? (users.findById(report.approvedBy) || {}) : {};

  const refs = new Map(); const receipts = []; const lines = [];
  for (const e of report.expenses) {
    let ref = null;
    if (e.receipt) {
      if (!refs.has(e.receipt.id)) {
        refs.set(e.receipt.id, `R${refs.size + 1}`);
        receipts.push({ ref: refs.get(e.receipt.id), title: e.merchant || e.receipt.originalName || 'Receipt', receipt: e.receipt, pages: [] });
      }
      ref = refs.get(e.receipt.id);
    }
    for (const l of e.lines) {
      lines.push({ ref, date: e.receiptDate, merchant: e.merchant, purpose: e.purpose, description: l.description, category: l.category, currency: l.currency || e.currency, amount: l.amount,
        fxRate: l.fxRate, fxRateDate: l.fxRateDate, fxSource: l.fxSource, fxFetchedAt: l.fxFetchedAt, fxOverrideBy: l.fxOverrideBy, fxOverrideReason: l.fxOverrideReason,
        baseAmount: l.baseAmount, onBehalfOf: l.onBehalfOf, tax: e.tax });
    }
  }
  if (withReceipts) for (const r of receipts) r.pages = await _pagesFor(r.receipt);
  for (const r of receipts) delete r.receipt;
  return { company, report, owner, manager, approver, lines, receipts, generatedAt: Date.now() };
}

module.exports = { reportPayload };
