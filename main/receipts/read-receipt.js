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
//   PDF without text → pages rendered to images; several pages are read
//                      together as ONE document, a single page like a photo
//
// Nothing here throws to the caller: a failure leaves the expense at
// review-needed with blank fields and a note, never lost.

// Above this many pages a scan is a stack of separate receipts, not one folio.
const MAX_PAGES_ONE_DOC = 10;

// A receipt that names no currency — a bare "$", a faded stub — comes back
// from the reader with an honest null, and the row keeps the base currency it
// was created with (routes/receipts.js). That default must not pass as a
// fact: a foreign receipt taken for SGD is priced at 1.0 and paid short. The
// note says the currency was assumed, and it goes when a person sets the
// currency or marks the receipt reviewed (routes/expenses.js).
const CURRENCY_NOTE_RE = /\s*No currency is printed on this receipt, so [A-Z]{3} was assumed\. Check it before marking the receipt reviewed\./;
const currencyNote = ccy => `No currency is printed on this receipt, so ${ccy} was assumed. Check it before marking the receipt reviewed.`;
function withoutCurrencyNote(msg) { return String(msg || '').replace(CURRENCY_NOTE_RE, '').trim() || null; }

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
  const exp = store.getExpense(expenseId);
  let purpose = exp?.purpose;
  if (!purpose && exp?.reportId) {
    try {
      const reports = require('../store/reports');
      const rep = reports.getReport(exp.reportId);
      if (rep?.purpose) purpose = rep.purpose;
    } catch {}
  }
  const patch = {
    merchant: r.merchant ?? undefined, receiptDate: r.date ?? undefined, receiptTime: r.time ?? undefined,
    invoiceNo: r.invoiceNumber ?? undefined, currency: r.currency ?? undefined,
    total: r.total ?? undefined, tax: r.tax ?? undefined, subTotal: r.subTotal ?? undefined,
    purpose: purpose ?? undefined,
    description: r.description ?? undefined, category: canonicalCategory(r.category) ?? undefined,
    // A successful read supersedes every earlier note about reading this
    // receipt — "could not be read", a suspected duplicate (flagIfSuspected
    // puts that one back if it still holds). What a read may add is that the
    // currency on the row is the default, not something it saw.
    errorMsg: r.currency == null && r.total != null && exp?.currency ? currencyNote(exp.currency) : null,
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
// for a person, never an automatic 'duplicate'. The note sits beside whatever
// the read left (the assumed-currency note), and a suspicion an earlier read
// raised is withdrawn when this read no longer bears it out.
const DUP_NOTE_RE = /\s*Possible duplicate of .*? — .*?\. Check before submitting\./;
function flagIfSuspected(expenseId) {
  const exp = store.getExpense(expenseId);
  if (!exp || exp.status === 'duplicate' || !exp.merchant || !exp.receiptDate || !exp.total) return;
  const dup = findDuplicate({
    store: store.dedupView(exp.companyId), profile: { dedup: { byHash: false, byNumber: false, byFields: true } },
    vendorName: exp.merchant, date: exp.receiptDate, amount: exp.total, excludeId: expenseId,
  });
  const prior = String(exp.errorMsg || '').replace(DUP_NOTE_RE, '').trim() || null;
  if (!dup || !dup.match || !dup.match.id) {
    if (prior !== (exp.errorMsg || null) || exp.duplicateOf) store.updateExpense(expenseId, { duplicateOf: null, errorMsg: prior });
    return;
  }
  store.updateExpense(expenseId, {
    duplicateOf: dup.match.id,
    errorMsg: [prior, `Possible duplicate of ${dup.match.invoiceNumber || dup.match.id} — ${dup.reason}. Check before submitting.`].filter(Boolean).join(' '),
  });
}

function _sibling({ companyId, userId, receiptId, source, page = null, box = null }) {
  return store.createExpense({ companyId, userId, receiptId, source, page, box, status: 'reading' });
}

// One read, one or several receipts. A clean split — the parser said the
// boxes are unambiguous — makes a sibling per extra receipt, each owning its
// region of the shared file; anything else is one expense holding the whole
// image. Returns the ids of the siblings it made.
async function _applyMany({ companyId, userId, receiptId, source, expenseId, page = null }, parsed) {
  const made = [];
  if (!parsed.split) { await applyRead(expenseId, parsed.receipts[0]); flagIfSuspected(expenseId); return made; }
  const [first, ...rest] = parsed.receipts;
  await applyRead(expenseId, first, { box: first.box || null }); flagIfSuspected(expenseId);
  for (const r of rest) {
    const sib = _sibling({ companyId, userId, receiptId, source, page, box: r.box || null });
    made.push(sib.id);
    await applyRead(sib.id, r); flagIfSuspected(sib.id);
  }
  return made;
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
          // Several pages are one document. A single page is read like a photo
          // and may hold several receipts scanned side by side; whether that
          // split is safe is the parser's call, exactly as for a photo. Until
          // this the extra receipts on such a page were silently dropped.
          parsed = await parser.parseReceiptPages(userId, rendered.pages.map(p => ({ buffer: p.buffer, mime: 'image/jpeg' })));
          if (parsed) touched.push(...await _applyMany({ companyId, userId, receiptId, source, expenseId }, parsed));
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
      if (parsed) touched.push(...await _applyMany({ companyId, userId, receiptId, source, expenseId }, parsed));
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

// When the expense owns a region of a shared image, the receipt whose box
// lies nearest that region is the one being re-read; otherwise the first.
function _nearest(out, box) {
  if (!out || !out.receipts || !out.receipts.length) return null;
  if (!box || out.receipts.length < 2) return out.receipts[0];
  const centre = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const [cy, cx] = centre(box);
  const withBox = out.receipts.filter(r => r.box);
  if (!withBox.length) return out.receipts[0];
  return withBox.reduce((best, r) => { const [ry, rx] = centre(r.box); const d = Math.hypot(ry - cy, rx - cx); return d < best.d ? { r, d } : best; }, { r: withBox[0], d: Infinity }).r;
}

// One document, read again onto ONE expense (no split): a photo goes back to
// the vision reader; a PDF to its text, or its rendered pages when it has none.
// Returns the normalised receipt or null.
async function readOne(userId, buffer, mime, { page = null, box = null } = {}) {
  if (mime !== 'application/pdf') return _nearest(await parser.parseReceiptImage(userId, buffer, mime), box);
  const extracted = await pdfPages.extractPages(buffer);
  if (extracted.hasText) {
    const text = page ? extracted.pages[page - 1] : extracted.pages.join('\n\n');
    const out = await parser.parseReceiptText(userId, text);
    return out ? out.receipts[0] : null;
  }
  const rendered = await pdfRender.renderPdfPages(buffer);
  if (!rendered || !rendered.pages.length) return null;
  const pages = page ? rendered.pages.filter(p => p.page === page) : rendered.pages.slice(0, MAX_PAGES_ONE_DOC);
  return _nearest(await parser.parseReceiptPages(userId, pages.map(p => ({ buffer: p.buffer, mime: 'image/jpeg' }))), box);
}

module.exports = { readReceipt, readOne, applyRead, buildLines, flagIfSuspected, currencyNote, withoutCurrencyNote, CURRENCY_NOTE_RE, MAX_PAGES_ONE_DOC };
