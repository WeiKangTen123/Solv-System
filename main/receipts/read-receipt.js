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
// A first read lands only on a row still 'reading': once anybody has edited,
// checked or claimed it, the reader's late answer would overwrite them with
// nothing in the change log. A re-read is asked for, and passes reread.
async function applyRead(expenseId, r, extra = {}, { reread = false } = {}) {
  const exp = store.getExpense(expenseId);
  if (!exp) return null;
  if (!reread && exp.status !== 'reading') {
    logger.info('A late read was not applied: the receipt had moved on', { expenseId, status: exp.status });
    return exp;
  }
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
    aiConfidence: r.confidence || 'low', aiReadAt: new Date().toISOString(),
    // What the reader saw on the paper, kept beside whatever the fields say
    // later, so a total that was changed away from the receipt shows.
    aiRead: { merchant: r.merchant ?? null, receiptDate: r.date ?? null, currency: r.currency ?? null, total: r.total ?? null,
              tax: r.tax ?? null, invoiceNo: r.invoiceNumber ?? null, category: canonicalCategory(r.category) ?? null },
    ...extra,
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


// ── One file, read: the receipts in it and where each one sits ──────────────
//
// readParts is the one place that decides how a file is read. It touches no
// rows: the upload path (readReceipt, below) turns the parts into expenses,
// and the archive import turns each into a record (claims/claim-import.js).
// The import used to read a PDF with readOne, which keeps only the first
// receipt, so a PDF of four e-receipts inside a ZIP became one record and the
// other three were lost without a word.
//
// Returns { parts: [{ r, page, box }], numPages, parsed, notes }. A part's r is
// null when that page or region could not be read; it still becomes a row, so
// nothing in the file is dropped silently.

// A page that came back from the vision reader with nothing a receipt has is
// a cover sheet, a blank or a signature page, not a receipt.
const _looksLikeReceipt = r => !!r && (r.total !== null && r.total !== undefined || !!r.merchant);
const _fromParsed = parsed => {
  if (!parsed || !parsed.receipts || !parsed.receipts.length) return [];
  if (!parsed.split) return [{ r: parsed.receipts[0], page: null, box: null }];
  return parsed.receipts.map(r => ({ r, page: null, box: r.box || null }));
};

async function readParts(userId, buffer, mime) {
  const notes = [];
  if (mime !== 'application/pdf') {
    const parsed = await parser.parseReceiptImage(userId, buffer, mime);
    return { parts: _fromParsed(parsed), numPages: null, parsed, notes };
  }

  const extracted = await pdfPages.extractPages(buffer);
  const numPages = extracted.numPages || null;
  const capNote = (read, what) => {
    if (numPages && read < numPages) notes.push(`Only the first ${read} of ${numPages} pages were ${what}; check the rest by hand.`);
  };

  if (!extracted.hasText) {
    const rendered = await pdfRender.renderPdfPages(buffer);
    if (!rendered || !rendered.pages.length) {
      notes.push('This PDF could not be read automatically. Type the fields from the receipt.');
      return { parts: [], numPages, parsed: null, notes };
    }
    capNote(rendered.pages.length, 'read');
    if (rendered.pages.length <= MAX_PAGES_ONE_DOC) {
      // Several pages are one document. A single page is read like a photo
      // and may hold several receipts scanned side by side; whether that
      // split is safe is the parser's call, exactly as for a photo.
      const parsed = await parser.parseReceiptPages(userId, rendered.pages.map(p => ({ buffer: p.buffer, mime: 'image/jpeg' })));
      return { parts: _fromParsed(parsed), numPages, parsed, notes };
    }
    // A thick scan: one receipt per page, read five pages to a call (the
    // batch reader checks each answer comes back against its own page, and
    // reads a page alone when it cannot tell). One call per page used to make
    // a twenty-page scan twenty calls.
    const reads = await parser.parseReceiptBatch(userId, rendered.pages.map(p => ({ buffer: p.buffer, mime: 'image/jpeg' })));
    const parts = rendered.pages.map((p, i) => ({ r: reads[i] || null, page: p.page, box: null }));
    return { parts, numPages, parsed: null, notes };
  }

  capNote(extracted.pages.length, 'read');
  const decision = pdfPages.splittablePages(extracted);
  let parts, parsed = null;
  if (!decision.split) {
    parsed = await parser.parseReceiptText(userId, extracted.pages.join('\n\n'));
    parts = parsed && parsed.receipts && parsed.receipts.length ? [{ r: parsed.receipts[0], page: null, box: null }] : [];
  } else {
    parts = [];
    for (const page of decision.pageNumbers) {
      const one = await parser.parseReceiptText(userId, extracted.pages[page - 1]);
      parts.push({ r: one && one.receipts ? one.receipts[0] : null, page, box: null });
    }
  }

  // Pages with no text in a PDF that has some: scans among typed pages, such
  // as a typed cover sheet with the receipts scanned behind it. They used to
  // be skipped, since the text was read and the images never were. Each is
  // drawn and read; one that holds a receipt becomes a part of its own.
  const blank = extracted.pages.map((t, i) => (String(t || '').length < pdfPages.MIN_PAGE_CHARS ? i + 1 : null)).filter(Boolean);
  if (blank.length && extracted.textPageCount) {
    const rendered = await pdfRender.renderPdfPages(buffer, { pages: blank.slice(0, 10) }).catch(() => null);
    for (const p of (rendered && rendered.pages) || []) {
      if (!blank.includes(p.page)) continue;
      const one = await parser.parseReceiptImage(userId, p.buffer, 'image/jpeg');
      const r = one && one.receipts ? one.receipts[0] : null;
      if (_looksLikeReceipt(r)) parts.push({ r, page: p.page, box: null });
    }
    // A single text part covering the whole file now sits beside page parts:
    // pin it to the first typed page so each row knows its place.
    if (parts.length > 1 && parts[0].page === null) parts[0].page = extracted.pages.findIndex(t => String(t || '').length >= pdfPages.MIN_PAGE_CHARS) + 1;
  }
  return { parts, numPages, parsed, notes };
}

// Another receipt found in the same file. It goes where the first one went:
// the same case, and the same default currency, or it was left out of the
// claim and priced as base currency with nothing to say it was assumed.
function _sibling({ companyId, userId, receiptId, source, page = null, box = null, parentId = null }) {
  const parent = parentId ? store.getExpense(parentId) : null;
  const sib = store.createExpense({ companyId, userId, receiptId, source, page, box, status: 'reading', currency: parent ? parent.currency : undefined });
  if (parent && parent.reportId) require('../store/reports').addExpense(parent.reportId, sib.id);
  return sib;
}

// The upload path: read the file, and make its parts into rows. The first
// part is the expense the upload created; every further part is a sibling
// owning its page or region of the shared file.
async function readReceipt({ companyId, userId, receiptId, expenseId, buffer, mime, source = 'upload' }) {
  const touched = [expenseId];
  let parsed = null;
  try {
    const out = await readParts(userId, buffer, mime);
    parsed = out.parsed;
    if (out.numPages) store.updateReceipt(receiptId, { pages: out.numPages });
    if (out.notes.length) {
      const e = store.getExpense(expenseId);
      store.updateExpense(expenseId, { errorMsg: [e && e.errorMsg, ...out.notes].filter(Boolean).join(' ') });
    }
    for (let k = 0; k < out.parts.length; k++) {
      const p = out.parts[k];
      let id = expenseId;
      if (k === 0) {
        const place = {};
        if (p.page) place.page = p.page;
        if (p.box) place.box = p.box;
        if (Object.keys(place).length) store.updateExpense(expenseId, place);
      } else {
        id = _sibling({ companyId, userId, receiptId, source, page: p.page, box: p.box, parentId: expenseId }).id;
        touched.push(id);
      }
      if (p.r) {
        // The notes the read left on the first row stay beside what applyRead writes.
        const keep = k === 0 && out.notes.length ? out.notes.join(' ') : null;
        await applyRead(id, p.r);
        if (keep) { const e = store.getExpense(id); store.updateExpense(id, { errorMsg: [e.errorMsg, keep].filter(Boolean).join(' ') }); }
        flagIfSuspected(id);
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
  const rendered = await pdfRender.renderPdfPages(buffer, page ? { pages: [page] } : { maxPages: MAX_PAGES_ONE_DOC });
  if (!rendered || !rendered.pages.length) return null;
  const pages = page ? rendered.pages.filter(p => p.page === page) : rendered.pages.slice(0, MAX_PAGES_ONE_DOC);
  return _nearest(await parser.parseReceiptPages(userId, pages.map(p => ({ buffer: p.buffer, mime: 'image/jpeg' }))), box);
}

module.exports = { readReceipt, readParts, readOne, applyRead, buildLines, flagIfSuspected, currencyNote, withoutCurrencyNote, CURRENCY_NOTE_RE, MAX_PAGES_ONE_DOC };
