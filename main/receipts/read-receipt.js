const parser    = require('./receipt-parser');
const pdfPages  = require('../pdf/pages');
const pdfRender = require('../pdf/render');
const store     = require('../store/expenses');
const { findDuplicate } = require('../intake/dedup');
const { canonicalCategory } = require('../intake/categories');
const logger    = require('../utils/logger');

// The one place that decides HOW a stored file is read and what the read does
// to the expense rows. Callers (the upload route, the phone route, the batch
// import, re-read) hand it a receipt that is already on disk.
//
//   photo            → vision; a clean multi-receipt photo splits into siblings
//   PDF with text    → text reader; pages that are one document read together,
//                      otherwise one expense per page
//   PDF without text → pages rendered to images, read together as ONE document
//
// Nothing here throws to the caller: a failure leaves the expense at
// review-needed with blank fields and a note, never lost.

// Above this many pages a scan is a stack of separate receipts, not one folio.
const MAX_PAGES_ONE_DOC = 10;

// One line per (category, on-behalf-of), summing exactly to the total. The
// reader's items rarely add up to the cent, so the residual goes to the
// largest line. Items that are nowhere near the total are not trusted, and the
// whole total sits on one line at the receipt's own category.
function buildLines(r, fallbackCategory) {
  const totalCents = Math.round((Number(r.total) || 0) * 100);
  if (totalCents <= 0) return [];
  const cat = canonicalCategory(r.category) || fallbackCategory || 'Other';
  const items = Array.isArray(r.lineItems) ? r.lineItems.filter(li => li && Number.isFinite(Number(li.unitAmount))) : [];

  const groups = new Map();
  for (const li of items) {
    const category = canonicalCategory(li.category) || cat;
    const onBehalfOf = li.onBehalfOf || null;
    const key = `${category}|${onBehalfOf || ''}`;
    const g = groups.get(key) || { category, onBehalfOf, cents: 0, names: [], count: 0 };
    g.cents += Math.round(Number(li.unitAmount) * 100);
    g.count++;
    if (li.description && !g.names.length) g.names.push(String(li.description).replace(/\s+/g, ' ').trim());
    groups.set(key, g);
  }
  const lines = [...groups.values()].filter(g => g.cents > 0);
  const sum = lines.reduce((s, g) => s + g.cents, 0);
  const tolerance = Math.max(100, Math.round(totalCents * 0.15));
  if (!lines.length || Math.abs(sum - totalCents) > tolerance) {
    return [{ category: cat, description: r.description || r.merchant || null, amount: totalCents / 100, onBehalfOf: null }];
  }
  lines.sort((a, b) => b.cents - a.cents);
  lines[0].cents += totalCents - sum;
  // The first charge names the line; the rest are counted. A report row that
  // recites forty folio lines is not a description.
  return lines.map(g => ({ category: g.category, description: (g.names[0] ? `${g.names[0].slice(0, 80)}${g.count > 1 ? ` +${g.count - 1} more` : ''}` : null), amount: g.cents / 100, onBehalfOf: g.onBehalfOf }));
}

// Writes a read onto an expense. undefined leaves a field alone, so a value
// the reader could not make out never erases one already typed.
async function applyRead(expenseId, r, extra = {}) {
  const patch = {
    merchant: r.merchant ?? undefined, receiptDate: r.date ?? undefined, receiptTime: r.time ?? undefined,
    invoiceNo: r.invoiceNumber ?? undefined, currency: r.currency ?? undefined,
    total: r.total ?? undefined, tax: r.tax ?? undefined, subTotal: r.subTotal ?? undefined,
    description: r.description ?? undefined, category: canonicalCategory(r.category) ?? undefined,
    aiConfidence: r.confidence || 'low', aiReadAt: new Date().toISOString(), ...extra,
  };
  const updated = store.updateExpense(expenseId, patch);
  if (!updated) return null;
  const lines = buildLines({ ...r, total: updated.total }, updated.category);
  if (lines.length) store.replaceLines(expenseId, lines.map(l => ({ ...l, currency: updated.currency })));
  // The rate is applied here, once the lines exist, so a read never leaves a
  // foreign expense without its base figure (or an honest 'rate pending').
  try { await require('../fx/apply').applyFx(expenseId); }
  catch (err) { logger.warn('Exchange rate not applied after read', { expenseId, error: err.message }); }
  return store.getExpense(expenseId);
}

// Same merchant, date and amount as another expense in the company: a note
// for a person, never an automatic 'duplicate'.
function flagIfSuspected(expenseId) {
  const exp = store.getExpense(expenseId);
  if (!exp || exp.status === 'duplicate' || !exp.merchant || !exp.receiptDate || !exp.total) return;
  const dup = findDuplicate({
    store: store.dedupView(exp.companyId), profile: { dedup: { byHash: false, byNumber: false, byFields: true } },
    vendorName: exp.merchant, date: exp.receiptDate, amount: exp.total, excludeId: expenseId,
  });
  if (!dup || !dup.match || !dup.match.id) return;
  store.updateExpense(expenseId, {
    duplicateOf: dup.match.id,
    errorMsg: `Possible duplicate of ${dup.match.invoiceNumber || dup.match.id} — ${dup.reason}. Check before submitting.`,
  });
}

function _sibling({ companyId, userId, receiptId, source, page = null, box = null }) {
  return store.createExpense({ companyId, userId, receiptId, source, page, box, status: 'reading' });
}

async function readReceipt({ companyId, userId, receiptId, expenseId, buffer, mime, source = 'upload' }) {
  const touched = [expenseId];
  let parsed = null;
  try {
    if (mime === 'application/pdf') {
      const extracted = await pdfPages.extractPages(buffer);
      store.updateReceipt(receiptId, { pages: extracted.numPages || null });

      if (!extracted.hasText) {
        const rendered = await pdfRender.renderPdfPages(buffer);
        if (!rendered || !rendered.pages.length) {
          store.updateExpense(expenseId, { errorMsg: 'This PDF could not be read automatically. Type the fields from the receipt.' });
        } else if (rendered.pages.length <= MAX_PAGES_ONE_DOC) {
          parsed = await parser.parseReceiptPages(userId, rendered.pages.map(p => ({ buffer: p.buffer, mime: 'image/jpeg' })));
          if (parsed) { await applyRead(expenseId, parsed.receipts[0]); flagIfSuspected(expenseId); }
        } else {
          // A thick scan: one receipt per page, each read on its own.
          store.updateExpense(expenseId, { page: 1 });
          for (const p of rendered.pages) {
            const id = p.page === 1 ? expenseId : _sibling({ companyId, userId, receiptId, source, page: p.page }).id;
            if (p.page !== 1) touched.push(id);
            const one = await parser.parseReceiptImage(userId, p.buffer, 'image/jpeg');
            if (one) { await applyRead(id, one.receipts[0]); flagIfSuspected(id); }
          }
        }
      } else {
        const decision = pdfPages.splittablePages(extracted);
        if (!decision.split) {
          parsed = await parser.parseReceiptText(userId, extracted.pages.join('\n\n'));
          if (parsed) { await applyRead(expenseId, parsed.receipts[0]); flagIfSuspected(expenseId); }
        } else {
          const [first, ...rest] = decision.pageNumbers;
          store.updateExpense(expenseId, { page: first });
          const targets = [[expenseId, first]];
          for (const page of rest) { const sib = _sibling({ companyId, userId, receiptId, source, page }); touched.push(sib.id); targets.push([sib.id, page]); }
          for (const [id, page] of targets) {
            const one = await parser.parseReceiptText(userId, extracted.pages[page - 1]);
            if (one) { await applyRead(id, one.receipts[0]); flagIfSuspected(id); }
          }
        }
      }
    } else {
      parsed = await parser.parseReceiptImage(userId, buffer, mime);
      if (parsed && !parsed.split) {
        await applyRead(expenseId, parsed.receipts[0]); flagIfSuspected(expenseId);
      } else if (parsed) {
        const [first, ...rest] = parsed.receipts;
        await applyRead(expenseId, first, { box: first.box || null }); flagIfSuspected(expenseId);
        for (const r of rest) {
          const sib = _sibling({ companyId, userId, receiptId, source, box: r.box || null });
          touched.push(sib.id);
          await applyRead(sib.id, r); flagIfSuspected(sib.id);
        }
      }
    }
  } catch (err) {
    logger.warn('Receipt read failed', { userId, receiptId, error: err.message });
  } finally {
    // However it ended, the read is over: every row from this file leaves
    // 'reading', and the receipt is stamped so the phone can tell "read,
    // nothing found" from "still reading".
    const at = new Date().toISOString();
    for (const id of touched) {
      const e = store.getExpense(id);
      if (e && e.status === 'reading') store.updateExpense(id, { status: 'review-needed' });
    }
    store.updateReceipt(receiptId, { parsedAt: at, parseJson: parsed ? parsed.receipts : null });
  }
  return { expenseIds: touched };
}

// One document, read again onto ONE expense (no split): a photo goes back to
// the vision reader; a PDF to its text, or its rendered pages when it has none.
// Returns the normalised receipt or null.
async function readOne(userId, buffer, mime, { page = null, box = null } = {}) {
  if (mime !== 'application/pdf') {
    const out = await parser.parseReceiptImage(userId, buffer, mime);
    if (!out) return null;
    if (box && out.receipts.length > 1) {
      const centre = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      const [cy, cx] = centre(box);
      const withBox = out.receipts.filter(r => r.box);
      if (withBox.length) return withBox.reduce((best, r) => { const [ry, rx] = centre(r.box); const d = Math.hypot(ry - cy, rx - cx); return d < best.d ? { r, d } : best; }, { r: withBox[0], d: Infinity }).r;
    }
    return out.receipts[0];
  }
  const extracted = await pdfPages.extractPages(buffer);
  if (extracted.hasText) {
    const text = page ? extracted.pages[page - 1] : extracted.pages.join('\n\n');
    const out = await parser.parseReceiptText(userId, text);
    return out ? out.receipts[0] : null;
  }
  const rendered = await pdfRender.renderPdfPages(buffer);
  if (!rendered || !rendered.pages.length) return null;
  const pages = page ? rendered.pages.filter(p => p.page === page) : rendered.pages.slice(0, MAX_PAGES_ONE_DOC);
  const out = await parser.parseReceiptPages(userId, pages.map(p => ({ buffer: p.buffer, mime: 'image/jpeg' })));
  return out ? out.receipts[0] : null;
}

module.exports = { readReceipt, readOne, applyRead, buildLines, flagIfSuspected, MAX_PAGES_ONE_DOC };
