const receiptStore = require('../utils/receipt-store');
const pdfRender    = require('../utils/pdf-render');
const logger       = require('../utils/logger');

// Xero takes attachments of at most 3 MB, JPG, PNG or PDF. Originals are kept
// at full size here, so the copy sent to Xero is made at posting time: an
// image is re-encoded smaller until it fits; a PDF over the limit is sent as
// one JPEG per page instead.
const MAX_BYTES = 3 * 1024 * 1024;

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

module.exports = { forReceipt, shrinkImage, MAX_BYTES };
