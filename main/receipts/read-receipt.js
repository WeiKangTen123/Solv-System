const parser    = require('./receipt-parser');
const pdfPages  = require('../pdf/pages');
const pdfRender = require('../pdf/render');
const store     = require('../store/expenses');
const { findDuplicate } = require('../intake/dedup');
const { canonicalCategory } = require('../intake/categories');
const logger    = require('../utils/logger');
const { firstReceipt, readSomething, overlapFraction } = require('./parse-result');

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
  const oneLine = [{ category: cat, description: r.description || r.merchant || null, amount: totalCents / 100, onBehalfOf: null }];
  if (!lines.length || Math.abs(sum - totalCents) > tolerance) return oneLine;
  lines.sort((a, b) => b.cents - a.cents);
  // Within the tolerance the residual can still be larger than the largest
  // line: ten people's 10.00 against a total of 87.00 left one line at -3.00.
  // A line of nothing or less is not a charge, so the total goes on one line.
  if (lines[0].cents + totalCents - sum <= 0) return oneLine;
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
// null when a typed page could not be read; it still becomes a row. A scanned
// page with no receipt on it makes no row, and a note names it. Nothing in the
// file is dropped silently.

// A photo splits by region, the pages of a scan by the pages each receipt is on.
const _fromParsed = parsed => {
  const first = firstReceipt(parsed);
  if (!first) return [];
  if (!parsed.split) return [{ r: first, page: null, box: null }];
  return parsed.receipts.map(r => ({ r, page: r.pages ? r.pages[0] : null, box: r.box || null }));
};

// Every AI key cooling down or out of quota: the reader never saw the file.
const UNAVAILABLE_NOTE = 'The reader could not reach the AI service just now. Press Re-read in a few minutes, or type the fields from the receipt.';

async function readParts(userId, buffer, mime) {
  const notes = [];
  const note = text => { if (!notes.includes(text)) notes.push(text); };
  const heard = parsed => { if (parsed && parsed.unavailable) note(UNAVAILABLE_NOTE); return parsed; };
  if (mime !== 'application/pdf') {
    const parsed = heard(await parser.parseReceiptImage(userId, buffer, mime));
    return { parts: _fromParsed(parsed), numPages: null, parsed, notes };
  }

  const extracted = await pdfPages.extractPages(buffer);
  const numPages = extracted.numPages || null;
  const capNote = (read, what) => {
    if (numPages && read < numPages) notes.push(`Only the first ${read} of ${numPages} pages were ${what}; check the rest by hand.`);
  };
  const unreadable = () => {
    notes.push('This PDF could not be read automatically. Type the fields from the receipt.');
    return { parts: [], numPages, parsed: null, notes };
  };
  // A file the text worker could not open, or that ran out its clock, is not
  // drawn as well: the renderer is the same engine, and a broken or hanging
  // PDF used to cost both timeouts before the person heard anything.
  if (extracted.failed) return unreadable();

  if (!extracted.hasText) {
    const rendered = await pdfRender.renderPdfPages(buffer);
    if (!rendered || !rendered.pages.length) return unreadable();
    capNote(rendered.pages.length, 'read');
    if (rendered.pages.length <= MAX_PAGES_ONE_DOC) {
      // Several pages are usually one document, and come back as one entry.
      // Pages that are plainly separate documents (another merchant, another
      // receipt number) come back as one part each, on its own pages, as
      // typed pages do. A single page is read like a photo and may hold
      // several receipts scanned side by side; whether either split is safe
      // is the parser's call.
      const parsed = heard(await parser.parseReceiptPages(userId, rendered.pages.map(p => ({ buffer: p.buffer, mime: 'image/jpeg' }))));
      if (rendered.pages.length > 1 && parsed && !parsed.split && parsed.receipts.length > 1) {
        notes.push(`The reader saw ${parsed.receipts.length} receipts in these pages but could not tell them apart safely, so they are kept as one. Check the pages and add any other receipt by hand.`);
      }
      return { parts: _fromParsed(parsed), numPages, parsed, notes };
    }
    // A thick scan: a stack of separate receipts.
    const parts = await _readScans(userId, rendered.pages, note);
    return { parts, numPages, parsed: null, notes };
  }

  capNote(extracted.pages.length, 'read');
  const decision = pdfPages.splittablePages(extracted);
  let parts, parsed = null;
  if (!decision.split) {
    parsed = heard(await parser.parseReceiptText(userId, extracted.pages.join('\n\n')));
    const r = firstReceipt(parsed);
    parts = r ? [{ r, page: null, box: null }] : [];
  } else {
    parts = [];
    for (const page of decision.pageNumbers) {
      const one = heard(await parser.parseReceiptText(userId, extracted.pages[page - 1]));
      parts.push({ r: firstReceipt(one), page, box: null });
    }
  }

  // Pages with no text in a PDF that has some: scans among typed pages, such
  // as a typed cover sheet with the receipts scanned behind it. They used to
  // be skipped, since the text was read and the images never were. Each is
  // drawn and read; one that holds a receipt becomes a part of its own. Only
  // the first ten used to be drawn, one call each, with nothing said of the
  // rest; now every one the renderer will draw is read, and any it will not is
  // named in a note.
  const blank = extracted.pages.map((t, i) => (pdfPages.pageHasText(t) ? null : i + 1)).filter(Boolean);
  if (blank.length && extracted.textPageCount) {
    const rendered = await pdfRender.renderPdfPages(buffer, { pages: blank }).catch(() => null);
    const scans = ((rendered && rendered.pages) || []).filter(p => blank.includes(p.page));
    if (scans.length < blank.length) note(`Only ${scans.length} of the ${blank.length} scanned pages were read; check the rest by hand.`);
    parts.push(...await _readScans(userId, scans, note));
    // A single text part read from the typed pages together keeps page null,
    // which means the whole file, beside the scanned pages' parts. It used to
    // be pinned to the first typed page, and a re-read then sent that page
    // alone: a folio whose total is on its last page went from 45,000 to 5,000.
  }
  return { parts, numPages, parsed, notes };
}

// Scanned pages that are separate receipts: a thick scan, or the scans behind
// a typed cover sheet. Read five pages to a call (the batch reader checks each
// answer comes back against its own page, and reads a page alone when it
// cannot tell); one call per page made a twenty-page scan twenty calls. A page
// holding two receipts is read again on its own and split like a photo. A page
// with no receipt on it (a blank, a signature page) makes no row, where it
// used to make an empty one, and the note names it.
async function _readScans(userId, pages, note) {
  if (!pages.length) return [];
  const reads = await parser.parseReceiptBatch(userId, pages.map(p => ({ buffer: p.buffer, mime: 'image/jpeg' })), { split: true });
  const parts = [], empty = [];
  pages.forEach((p, i) => {
    if (reads[i] && reads[i].unavailable) note(UNAVAILABLE_NOTE);
    // Nothing a receipt has: a cover sheet, a blank or a signature page.
    const found = _fromParsed(reads[i]).filter(part => readSomething(part.r));
    if (!found.length) empty.push(p.page);
    for (const part of found) parts.push({ ...part, page: p.page });
  });
  if (empty.length === 1) note(`No receipt was read on page ${empty[0]}; check it by hand.`);
  else if (empty.length) note(`No receipt was read on pages ${empty.join(', ')}; check them by hand.`);
  return parts;
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
// The nearest must also lie over the region. When the re-read found only the
// other receipt, or none with a box, it used to be taken, and one half of a
// split photo was re-read with the other half's figures. Nothing is better
// than that: the re-read answers unreadable.
const MIN_REREAD_OVERLAP = 0.5;
function _nearest(out, box) {
  const first = firstReceipt(out);
  if (!first || !box) return first;
  const centre = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const [cy, cx] = centre(box);
  const withBox = out.receipts.filter(r => r.box);
  if (!withBox.length) return null;
  const best = withBox.reduce((b, r) => { const [ry, rx] = centre(r.box); const d = Math.hypot(ry - cy, rx - cx); return d < b.d ? { r, d } : b; }, { r: withBox[0], d: Infinity }).r;
  return overlapFraction(best.box, box) >= MIN_REREAD_OVERLAP ? best : null;
}

// One page of a PDF, drawn and read like a photo.
async function _scannedPage(userId, buffer, page, box) {
  const rendered = await pdfRender.renderPdfPages(buffer, { pages: [page] });
  const p = rendered && rendered.pages.find(x => x.page === page);
  return p ? _nearest(await parser.parseReceiptImage(userId, p.buffer, 'image/jpeg'), box) : null;
}

// One document, read again onto ONE expense (no split): a photo goes back to
// the vision reader; a PDF to its text, or its rendered pages when it has none.
// Returns the normalised receipt or null.
//
// `page` is where the row's receipt is, null for the whole file. What was read
// as part of a whole is read as part of that whole again, and a scanned page
// as the image it is.
async function readOne(userId, buffer, mime, { page = null, box = null } = {}) {
  if (mime !== 'application/pdf') return _nearest(await parser.parseReceiptImage(userId, buffer, mime), box);
  const extracted = await pdfPages.extractPages(buffer);
  if (extracted.failed) return null;
  if (extracted.hasText) {
    // A scanned page among typed ones has no text to send: the text reader
    // was handed an empty page and could only answer unreadable.
    if (page && !pdfPages.pageHasText(extracted.pages[page - 1])) return _scannedPage(userId, buffer, page, box);
    // Typed pages read together the first time are read together again,
    // whichever of them the row names: rows made before page null meant the
    // whole file were pinned to the first typed page.
    const alone = page && pdfPages.splittablePages(extracted).split;
    return firstReceipt(await parser.parseReceiptText(userId, alone ? extracted.pages[page - 1] : extracted.pages.join('\n\n')));
  }
  // A scan of up to ten pages was read whole, so it is read whole again and
  // the row's receipt found by the pages it is on; a receipt on pages 2 and 3
  // re-read from page 2 alone lost its total. A page of a longer scan was
  // read on its own, and so is one the reader no longer keeps apart.
  const whole = !page || (extracted.numPages > 1 && extracted.numPages <= MAX_PAGES_ONE_DOC);
  if (!whole) return _scannedPage(userId, buffer, page, box);
  const rendered = await pdfRender.renderPdfPages(buffer, { maxPages: MAX_PAGES_ONE_DOC });
  if (!rendered || !rendered.pages.length) return null;
  const out = await parser.parseReceiptPages(userId, rendered.pages.slice(0, MAX_PAGES_ONE_DOC).map(p => ({ buffer: p.buffer, mime: 'image/jpeg' })));
  if (!page) return _nearest(out, box);
  const mine = out && out.split ? out.receipts.find(r => r.pages && r.pages.includes(page)) : null;
  return mine || _scannedPage(userId, buffer, page, box);
}

module.exports = { readReceipt, readParts, readOne, applyRead, buildLines, flagIfSuspected, currencyNote, withoutCurrencyNote, CURRENCY_NOTE_RE, MAX_PAGES_ONE_DOC };
