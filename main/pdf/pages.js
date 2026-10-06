const textExtract = require('./text-extract');
const logger      = require('../utils/logger');

// Splits a PDF into per-page text.
//
// A PDF of scanned receipts is usually one receipt per page, so each page should
// become its own record. Doing that needs the pages separated.
//
// The text is read in a child process by text-extract.js. It used to be read
// here, in the server, by pdf-parse — a library that bundles a PDF engine from
// 2017. One crafted PDF could hang every request, and the same engine could
// not open some perfectly valid modern PDFs at all ("bad XRef entry").
//
// The limit: this reads the TEXT LAYER. A digital receipt (emailed, generated)
// has one. A photographed page scanned into a PDF does not, and comes back
// empty, which read-receipt.js answers by rendering the pages to images.

// Below this a "page" is a header or a stray mark, not a receipt. Asked one way
// everywhere a page's text is weighed, here and in read-receipt.js, so a page
// is never "blank" to one and "text" to the other.
const MIN_PAGE_CHARS = 40;
function pageHasText(text) { return typeof text === 'string' && text.trim().length >= MIN_PAGE_CHARS; }

async function extractPages(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { pages: [], numPages: 0, hasText: false };

  try {
    const data = await textExtract.extractText(buffer);
    const pages = data.pages;
    const withText = pages.filter(pageHasText);
    return {
      pages,
      numPages: data.numPages || pages.length,
      // False for a scan: every page is images, so there is nothing to read.
      hasText: withText.length > 0,
      textPageCount: withText.length,
    };
  } catch (err) {
    // failed is not the same as "no text". The worker could not open the file
    // or ran out of time; the renderer is the same engine on a longer clock,
    // and drawing the pages used to cost a second timeout to learn the same.
    logger.warn('PDF page extraction failed', { error: err.message });
    return { pages: [], numPages: 0, hasText: false, textPageCount: 0, failed: true };
  }
}

// Are these text pages ONE document? A hotel folio repeats its invoice number
// on every page; a scan of several receipts does not. Failing a number, a
// header that opens every page is taken as the same document.
// The token must carry a digit: "Receipt total" is not a receipt number.
const NUMBER_RE = /(?:invoice|bill|receipt|folio|statement)\s*(?:no|number|num|#)?\.?\s*[:#]?\s*((?=[A-Z0-9\/-]*\d)[A-Z0-9][A-Z0-9\/-]{2,})/i;
function sameDocument(pages = []) {
  const texts = pages.filter(pageHasText);
  if (texts.length < 2) return false;
  const nums = texts.map(t => { const m = NUMBER_RE.exec(t); return m ? m[1].toUpperCase() : null; });
  if (nums.every(Boolean)) return new Set(nums).size === 1;
  // A repeated header only counts for the document kinds that run to several
  // pages. Two taxi e-receipts share a header too, and those are two receipts.
  const norm = t => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const head = norm(texts[0]).slice(0, 48);
  if (head.length < 20 || !/\b(invoice|folio|statement)\b/.test(head)) return false;
  return texts.slice(1).every(t => norm(t).includes(head));
}

// Which pages are worth making a record for. A one-page PDF is never "split" —
// it is just an ordinary single receipt.
function splittablePages({ pages = [], hasText = false } = {}) {
  if (!hasText || pages.length < 2) return { split: false, pageNumbers: [], reason: !hasText ? 'no text layer — the PDF is a scan' : 'single page' };
  if (sameDocument(pages)) return { split: false, pageNumbers: [], reason: 'pages of one document' };
  const pageNumbers = pages
    .map((text, i) => ({ text, page: i + 1 }))
    .filter(p => pageHasText(p.text))
    .map(p => p.page);

  // Every page must carry something, or we would create blank records for the
  // ones that do not.
  if (pageNumbers.length < 2) return { split: false, pageNumbers: [], reason: 'fewer than two pages have readable text' };
  return { split: true, pageNumbers, reason: null };
}

module.exports = { extractPages, splittablePages, sameDocument, pageHasText, MIN_PAGE_CHARS };
