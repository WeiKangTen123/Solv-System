const parser    = require('./receipt-parser');
const pdfPages  = require('../pdf/pages');
const pdfRender = require('../pdf/render');
const store     = require('../store/expenses');
const { findDuplicate, possibleDuplicateNote, POSSIBLE_DUPLICATE_RE: DUP_NOTE_RE } = require('../intake/dedup');
const { canonicalCategory } = require('../intake/categories');
const logger    = require('../utils/logger');
const { firstReceipt, readSomething, overlapFraction } = require('./parse-result');
const lineKinds = require('./line-kinds');
const { isoDate } = require('../intake/document');

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

// The reader's items grouped by (category, on-behalf-of), in cents. A
// discount or rounding stays negative inside its group, and a group that
// comes to nothing or less is not a charge and is left out.
function _groups(r, cat) {
  const items = Array.isArray(r.lineItems) ? r.lineItems.filter(li => li && Number.isFinite(Number(li.unitAmount))) : [];
  const groups = new Map();
  for (const li of items) {
    const category = canonicalCategory(li.category) || cat;
    const onBehalfOf = li.onBehalfOf || null;
    const key = `${category}|${onBehalfOf || ''}`;
    const g = groups.get(key) || { category, onBehalfOf, cents: 0, names: [], count: 0 };
    g.cents += Math.round(Number(li.unitAmount) * 100);
    g.count++;
    if (li.description && !g.names.length && Number(li.unitAmount) > 0) g.names.push(String(li.description).replace(/\s+/g, ' ').trim());
    groups.set(key, g);
  }
  const lines = [...groups.values()].filter(g => g.cents > 0);
  return { lines, sum: lines.reduce((s, g) => s + g.cents, 0) };
}

// One line per (category, on-behalf-of), summing exactly to the total. The
// reader's items rarely add up to the cent, and the difference goes to the
// claimant's own line in the receipt's category, made if there is none. It
// used to go to the largest line, whoever's and whatever it was: a dinner the
// reader missed on a folio was put on a colleague's room. Items that are
// nowhere near the total are not trusted, and the whole total sits on one
// line at the receipt's own category. How far the items were from the total
// is a read-time check (readChecks, below).
function buildLines(r, fallbackCategory) {
  const totalCents = Math.round((Number(r.total) || 0) * 100);
  if (totalCents <= 0) return [];
  const cat = canonicalCategory(r.category) || fallbackCategory || 'Other';
  const { lines, sum } = _groups(r, cat);
  const tolerance = Math.max(100, Math.round(totalCents * 0.15));
  const oneLine = [{ category: cat, description: r.description || r.merchant || null, amount: totalCents / 100, onBehalfOf: null }];
  if (!lines.length || Math.abs(sum - totalCents) > tolerance) return oneLine;
  if (sum !== totalCents) {
    let own = lines.find(g => g.category === cat && !g.onBehalfOf);
    if (!own) {
      own = { category: cat, onBehalfOf: null, cents: 0, names: [r.description || r.merchant].filter(Boolean), count: 1 };
      lines.push(own);
    }
    // Taking the difference off can leave the claimant's line at nothing or
    // less: ten people's 10.00 against a total of 87.00. A line of nothing is
    // not a charge, and the difference is nobody else's, so the total goes on
    // one line.
    if (own.cents + totalCents - sum <= 0) return oneLine;
    own.cents += totalCents - sum;
  }
  lines.sort((a, b) => b.cents - a.cents);
  // The first charge names the line; the rest are counted. A report row that
  // recites forty folio lines is not a description.
  return lines.map(g => ({ category: g.category, description: (g.names[0] ? `${g.names[0].slice(0, 80)}${g.count > 1 ? ` +${g.count - 1} more` : ''}` : null), amount: g.cents / 100, onBehalfOf: g.onBehalfOf }));
}

// ── What the reader saw that is worth a look ────────────────────────────────
//
// Worked out when the receipt is read and kept in aiRead.checks, beside what
// the reader read: the reader's items are not kept on the expense, and once
// somebody edits the lines nothing would remain to judge them by. The flags
// (flags.js) say these in words. All money is as printed, in the receipt's
// own currency.
//
//   subtotalMismatch  the subtotal and the tax do not come to the total, with
//                     or without the service charges, tips, levies, rounding
//                     and discounts on the receipt: { subtotal, tax, total }
//   chargedTwice      the same charge for the same person, at the same amount,
//                     more than once: [{ description, amount, count }]
//   people            the other people whose charges the lines carry
//   adjusted          the items were more than 2% off the total, and the
//                     difference was made up on a line: { amount, pct }, the
//                     amount added to the items (negative when taken off)
//   dateOrder         a month-first date whose day could be its month:
//                     { read, other }
const ADJUSTED_SHARE = 0.02;
function readChecks(r, lines) {
  if (!r) return null;
  return {
    subtotalMismatch: _subtotalMismatch(r),
    chargedTwice: _chargedTwice(r),
    people: [...new Set((lines || []).map(l => l.onBehalfOf).filter(Boolean))],
    adjusted: _adjusted(r),
    dateOrder: _dateOrderCheck(r),
  };
}

const _c = v => Math.round(Number(v) * 100);
function _subtotalMismatch(r) {
  if (r.subTotal == null || r.tax == null || !(Number(r.total) > 0)) return null;
  const items = Array.isArray(r.lineItems) ? r.lineItems : [];
  const extra = items.filter(li => lineKinds.adjustmentLine(li.description)).reduce((s, li) => s + _c(li.unitAmount), 0);
  const off = items.filter(li => Number(li.unitAmount) < 0 && !lineKinds.adjustmentLine(li.description) && !lineKinds.taxLine(li.description)).reduce((s, li) => s + _c(li.unitAmount), 0);
  const base = _c(r.subTotal) + _c(r.tax);
  // Whether a discount or a service charge sits above the subtotal or below
  // it is not something the lines say, so each way is allowed.
  const total = _c(r.total);
  if ([base, base + extra, base + off, base + extra + off].some(x => Math.abs(x - total) <= 2)) return null;
  return { subtotal: Number(r.subTotal), tax: Number(r.tax), total: Number(r.total) };
}

// A tax line repeats with the charge it is on; only the charge is named.
function _chargedTwice(r) {
  const seen = new Map();
  for (const li of Array.isArray(r.lineItems) ? r.lineItems : []) {
    const cents = _c(li.unitAmount);
    if (!(cents > 0) || lineKinds.taxLine(li.description)) continue;
    const description = String(li.description || '').replace(/\s+/g, ' ').trim();
    if (!description) continue;
    const key = `${description.toLowerCase()}|${cents}|${li.onBehalfOf || ''}`;
    const s = seen.get(key) || { description, amount: cents / 100, count: 0 };
    s.count++;
    seen.set(key, s);
  }
  return [...seen.values()].filter(s => s.count > 1).sort((a, b) => b.amount - a.amount);
}

function _adjusted(r) {
  const total = _c(r.total);
  if (!(total > 0)) return null;
  const { lines, sum } = _groups(r, canonicalCategory(r.category) || 'Other');
  if (!lines.length || Math.abs(total - sum) <= total * ADJUSTED_SHARE) return null;
  return { amount: (total - sum) / 100, pct: Math.round((Math.abs(total - sum) / total) * 1000) / 10 };
}

// 10/09/2026 from a month-first country is 9 October, and could be 10
// September if the receipt was printed the other way. Not asked of a date
// printed with its month as a word or its year first, or of one whose day
// and month are the same, or whose other reading is a day still to come.
function _dateOrderCheck(r) {
  if (!r.date || !(r.country === 'US' || r.dateOrder === 'MDY')) return null;
  if (r.datePrinted) {
    const parts = String(r.datePrinted).match(/(\d{1,4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})/);
    if (!parts || parts[1].length === 4) return null;
  }
  const [y, m, d] = r.date.split('-');
  if (Number(m) > 12 || Number(d) > 12 || m === d) return null;
  const other = isoDate(`${y}-${d}-${m}`);
  return other ? { read: r.date, other } : null;
}

// What a read that saw a refund says on the receipt, in place of an amount.
const REFUND_NOTE = 'This looks like a refund; refunds are not claimed here.';

// Writes a read onto an expense. undefined leaves a field alone, so a value
// the reader could not make out never erases one already typed.
// A first read lands only on a row still 'reading': once anybody has edited,
// checked or claimed it, the reader's late answer would overwrite them with
// nothing in the change log. A re-read is asked for, and passes reread.
async function applyRead(expenseId, r, { reread = false } = {}) {
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
    city: r.city ?? undefined, country: r.country ?? undefined, docType: r.docType ?? undefined,
    // A successful read supersedes every earlier note about reading this
    // receipt — "could not be read", a suspected duplicate (flagIfSuspected
    // puts that one back if it still holds). What a read may add is that the
    // currency on the row is the default, not something it saw, or that the
    // receipt is a refund and so has no amount to claim.
    errorMsg: [r.refund ? REFUND_NOTE : null, r.currency == null && r.total != null && exp?.currency ? currencyNote(exp.currency) : null].filter(Boolean).join(' ') || null,
    aiConfidence: r.confidence || 'low', aiReadAt: new Date().toISOString(),
    // What the reader saw on the paper, kept beside whatever the fields say
    // later, so a total that was changed away from the receipt shows; and
    // what in it was worth a look, judged then, from the reader's own items.
    aiRead: { merchant: r.merchant ?? null, receiptDate: r.date ?? null, currency: r.currency ?? null, total: r.total ?? null,
              tax: r.tax ?? null, invoiceNo: r.invoiceNumber ?? null, category: canonicalCategory(r.category) ?? null,
              city: r.city ?? null, country: r.country ?? null, docType: r.docType ?? null,
              checks: readChecks(r, buildLines(r, canonicalCategory(r.category) || exp.category)) },
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
    errorMsg: [prior, possibleDuplicateNote(dup.match, dup.reason, exp.userId)].filter(Boolean).join(' '),
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
//
// Only while that case is still open. A read can take a minute, and a case
// claimed in that minute is locked: a receipt filed into it then would be
// claimed without anyone having seen it. It is left out of any case, with a
// note saying why. Returns the row and that note, if any.
function _sibling({ companyId, userId, receiptId, source, page = null, box = null, parentId = null }) {
  const parent = parentId ? store.getExpense(parentId) : null;
  const sib = store.createExpense({ companyId, userId, receiptId, source, page, box, status: 'reading', currency: parent ? parent.currency : undefined });
  if (!parent || !parent.reportId) return { sib, note: null };
  const reports = require('../store/reports');
  const rep = reports.head(parent.reportId);
  if (require('../reports/workflow').isEditable(rep)) {
    reports.addExpense(parent.reportId, sib.id);
    return { sib, note: null };
  }
  const note = `This receipt was in the same file as one in case ${rep ? rep.number : parent.reportId}, which was claimed while it was being read, so it was not added to that case.`;
  store.updateExpense(sib.id, { errorMsg: note });
  return { sib, note };
}

// The upload path: read the file, and make its parts into rows. The first
// part is the expense the upload created; every further part is a sibling
// owning its page or region of the shared file.
//
// With deferIfUnavailable (the read queue, receipts/read-queue.js), a read
// that found every AI key busy and so read nothing at all answers
// { unavailable: true } and touches nothing: the rows stay 'reading' and the
// receipt unstamped, for the queue to try again in a few minutes. Released
// with "press Re-read in a few minutes", the person had to do the waiting.
// A read that got anything at all lands as it always has.
async function readReceipt({ companyId, userId, receiptId, expenseId, buffer, mime, source = 'upload' }, { deferIfUnavailable = false } = {}) {
  const touched = [expenseId];
  let parsed = null;
  let deferred = false;
  try {
    const out = await readParts(userId, buffer, mime);
    if (deferIfUnavailable && out.notes.includes(UNAVAILABLE_NOTE) && !out.parts.some(p => p.r)) {
      deferred = true;
      return { unavailable: true };
    }
    parsed = out.parsed;
    if (out.numPages) store.updateReceipt(receiptId, { pages: out.numPages });
    if (out.notes.length) {
      const e = store.getExpense(expenseId);
      store.updateExpense(expenseId, { errorMsg: [e && e.errorMsg, ...out.notes].filter(Boolean).join(' ') });
    }
    for (let k = 0; k < out.parts.length; k++) {
      const p = out.parts[k];
      let id = expenseId;
      // The notes the read left on a row stay beside what applyRead writes.
      let keep = k === 0 && out.notes.length ? out.notes.join(' ') : null;
      if (k === 0) {
        const place = {};
        if (p.page) place.page = p.page;
        if (p.box) place.box = p.box;
        if (Object.keys(place).length) store.updateExpense(expenseId, place);
      } else {
        const made = _sibling({ companyId, userId, receiptId, source, page: p.page, box: p.box, parentId: expenseId });
        id = made.sib.id;
        keep = made.note;
        touched.push(id);
      }
      if (p.r) {
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
    // nothing found" from "still reading". Unless it was put off, when it
    // is not over.
    if (!deferred) {
      const at = new Date().toISOString();
      for (const id of touched) {
        const e = store.getExpense(id);
        if (e && e.status === 'reading') store.updateExpense(id, { status: 'review-needed' });
      }
      store.updateReceipt(receiptId, { parsedAt: at, parseJson: parsed ? parsed.receipts : null });
    }
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

module.exports = { readReceipt, readParts, readOne, applyRead, buildLines, readChecks, flagIfSuspected, currencyNote, withoutCurrencyNote, CURRENCY_NOTE_RE, MAX_PAGES_ONE_DOC, UNAVAILABLE_NOTE, REFUND_NOTE };
