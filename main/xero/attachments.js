const receiptStore = require('../receipts/receipt-store');
const pdfRender    = require('../pdf/render');
const logger       = require('../utils/logger');

// Xero takes attachments of at most 3 MB, JPG, PNG or PDF. Originals are kept
// at full size here, so the copy sent to Xero is made at posting time: an
// image is re-encoded smaller until it fits; a PDF over the limit is sent as
// one JPEG per page instead.
const MAX_BYTES = 3 * 1024 * 1024;
// And at most ten on one bill (developer.xero.com/documentation/api/
// accounting/invoices). A case of fourteen receipts lost the last four, with
// a note on the case for each; one with a hotel folio of ten pages lost
// nearly everything after it. Past ten, the case PDF goes instead (casePdfs).
const MAX_FILES = 10;

async function shrinkImage(buffer) {
  const sharp = require('sharp');
  const meta = await sharp(buffer).metadata();
  let width = Math.min(meta.width || 2000, 2000);
  for (const quality of [82, 72, 62, 52, 42, 32]) {
    const out = await sharp(buffer).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= MAX_BYTES) return out;
    width = Math.round(width * 0.8);
  }
  return null;
}

// Returns [{ name, mime, buffer }] for one receipt; empty when nothing fits.
async function forReceipt(receipt, { ref = 'R1' } = {}) {
  const buffer = receiptStore.forUser(receipt.userId).read(receipt.file);
  if (!buffer) return [];
  try {
    if (receipt.mime === 'application/pdf') {
      if (buffer.length <= MAX_BYTES) return [{ name: `${ref}.pdf`, mime: 'application/pdf', buffer }];
      const rendered = await pdfRender.renderPdfPages(buffer, { dpi: 110, maxPages: 10 });
      const out = [];
      for (const p of (rendered ? rendered.pages : [])) {
        const jpg = p.buffer.length <= MAX_BYTES ? p.buffer : await shrinkImage(p.buffer);
        if (jpg) out.push({ name: `${ref}-p${p.page}.jpg`, mime: 'image/jpeg', buffer: jpg });
      }
      return out;
    }
    if (buffer.length <= MAX_BYTES) return [{ name: `${ref}.${receipt.mime === 'image/png' ? 'png' : 'jpg'}`, mime: receipt.mime, buffer }];
    const jpg = await shrinkImage(buffer);
    return jpg ? [{ name: `${ref}.jpg`, mime: 'image/jpeg', buffer: jpg }] : [];
  } catch (err) {
    logger.warn('Receipt could not be prepared for Xero', { receipt: receipt.id, error: err.message });
    return [];
  }
}

// A page's own objects around its picture, and room for the estimate to be
// wrong: what a part will weigh is worked out from its pictures, then the
// part is made and weighed for real.
const PAGE_BYTES = 2048;
const FILL = 0.97;

const _pictureBytes = p => {
  const at = p.dataUri.indexOf(',');
  return Math.ceil((p.dataUri.length - at - 1) * 3 / 4);
};
const _weight = r => r.pages.reduce((n, p) => n + _pictureBytes(p) + PAGE_BYTES, PAGE_BYTES);
const _number = ref => String(ref).replace(/^R/, '');

// A receipt whose pictures will not fit in one file even on their own, drawn
// again smaller until they do. Null when even the smallest is too heavy.
async function _lighter(r, budget) {
  const sharp = require('sharp');
  const pictures = r.pages.map(p => Buffer.from(p.dataUri.slice(p.dataUri.indexOf(',') + 1), 'base64'));
  for (const [edge, quality] of [[1400, 62], [1200, 52], [1000, 44], [800, 36]]) {
    const pages = [];
    for (const b of pictures) {
      const jpg = await sharp(b).resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer();
      pages.push({ dataUri: `data:image/jpeg;base64,${jpg.toString('base64')}` });
    }
    const out = { ...r, pages };
    if (_weight(out) <= budget) return out;
  }
  return null;
}

// The case PDF, for a bill that would need more than MAX_FILES attachments:
// the same document the PDF export makes (reports/expense-doc.js), the cover
// and then every receipt, cut between receipts into as few files as fit
// MAX_BYTES, in order, the cover in the first. `payload` is reportPayload
// with its receipts' pages (withReceipts: true).
//
// Returns { files: [{ name, mime, buffer, refs }], left: [ref] }: `left` is
// what did not fit in maxFiles files, or a receipt too heavy for any file.
// Files are named for the case and the receipts in them, "EXP-2026-0002
// receipts 1-8.pdf", the numbers the printed report gives them (R1–R8).
async function casePdfs(payload, { maxBytes = MAX_BYTES, maxFiles = MAX_FILES } = {}) {
  const doc = require('../reports/expense-doc');
  const exporter = require('../reports/expense-export');
  const receipts = payload.receipts || [];
  const number = payload.report.number || 'Case';

  // The export with nothing appended is the cover; the receipts start where
  // it ends. The cover is made from every receipt, so it lists them all
  // whichever file each lands in.
  const shell = doc.expenseReportDoc({ ...payload, receipts: [] });
  const coverEnd = shell.content.length;
  const cover = doc.expenseReportDoc({ ...payload, receipts: receipts.map(r => ({ ...r, pages: [] })) }).content.slice(0, coverEnd);
  const pagesOf = r => doc.expenseReportDoc({ ...payload, receipts: [r] }).content.slice(coverEnd);
  const render = (withCover, list) => {
    const content = withCover ? [...cover] : [];
    for (const r of list) content.push(...pagesOf(r));
    // A file that starts with a receipt starts on its first page, not after
    // a blank one.
    if (!withCover && content.length) { content[0] = { ...content[0] }; delete content[0].pageBreak; }
    return exporter.pdfBuffer({ ...shell, content });
  };

  const budget = Math.floor(maxBytes * FILL);
  const coverBytes = (await render(true, [])).length;
  const items = [];
  for (const r of receipts) {
    const light = coverBytes + _weight(r) <= budget ? r : await _lighter(r, budget - coverBytes);
    items.push({ r: light || r, bytes: light ? _weight(light) : Infinity });
  }

  const files = [];
  const left = [];
  let i = 0;
  while (i < items.length && files.length < maxFiles) {
    if (items[i].bytes === Infinity) { left.push(items[i].r.ref); i++; continue; }
    const withCover = !files.length;
    let weight = withCover ? coverBytes : 0;
    let j = i;
    while (j < items.length && items[j].bytes !== Infinity && (j === i || weight + items[j].bytes <= budget)) weight += items[j++].bytes;
    // Made and weighed; a receipt goes back to the next file until it fits.
    let buffer = await render(withCover, items.slice(i, j).map(x => x.r));
    while (buffer.length > maxBytes && j - i > 1) buffer = await render(withCover, items.slice(i, --j).map(x => x.r));
    if (buffer.length > maxBytes) { left.push(items[i].r.ref); i++; continue; }
    const refs = items.slice(i, j).map(x => x.r.ref);
    const span = refs.length === 1 ? `receipt ${_number(refs[0])}` : `receipts ${_number(refs[0])}-${_number(refs.at(-1))}`;
    files.push({ name: `${number} ${span}.pdf`, mime: 'application/pdf', buffer, refs });
    i = j;
  }
  for (; i < items.length; i++) left.push(items[i].r.ref);
  return { files, left };
}

module.exports = { forReceipt, shrinkImage, casePdfs, MAX_BYTES, MAX_FILES };
