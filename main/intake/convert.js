const path = require('path');
const { HttpError } = require('../utils/http-error');
const { loadSharp } = require('../receipts/load-sharp');
const { MAX_BYTES } = require('../receipts/receipt-store');
const logger = require('../utils/logger');

// What a received file becomes before it is stored (routes/receipts.js).
//
// The store, the reader, the thumbnails and Xero all take JPEG, PNG and PDF,
// and those are kept exactly as they arrived. Everything else a phone or a
// scanner makes is turned into one of them here, once, so nothing downstream
// has to learn a new format: an iPhone's HEIC, an Android screenshot's WebP,
// a GIF, an AVIF and a single-page TIFF become a JPEG; a TIFF of several
// pages becomes a PDF of one JPEG per page, which the scanned-PDF reader
// already reads as one document. Only the converted file is kept; the receipt
// row records what it was converted from.
//
// The bytes decide what a file is. The type a browser declares and the name a
// file carries are claims, and are only used to say what was refused.

// Every converted image is drawn the way the reader is sent one
// (receipts/image-prep.js): the phone's orientation applied to the pixels, no
// longer than 2400 px on its long side, laid on white paper because JPEG has
// no transparency, and every metadata block left behind, the photo's GPS
// position included.
const MAX_SIDE = 2400;
const QUALITY  = 85;
// A decompression bomb is a small file that claims a vast picture. libvips'
// own limit is 268 MP; nothing photographed as a receipt comes near this.
const MAX_PIXELS = 150 * 1000 * 1000;
// A multi-page TIFF past this is a stack of documents, not a receipt, and the
// reader stops at twenty pages anyway (pdf/render.js).
const MAX_TIFF_PAGES = 20;
// pdf/render.js draws a page at 150 dpi. A page sized at that density comes
// back from the renderer at the pixels it was given, no blurrier and no
// bigger.
const PAGE_DPI = 150;
// A PDF of twenty scans at full quality can pass the 15 MB a receipt may be.
// Each pass is smaller than the last, and the first that fits is kept.
const PDF_STEPS = [
  { side: MAX_SIDE, quality: QUALITY },
  { side: 1800, quality: 75 },
  { side: 1400, quality: 70 },
  { side: 1100, quality: 65 },
];

const KEEP    = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const CONVERT = new Set(['image/heic', 'image/heif', 'image/avif', 'image/webp', 'image/gif', 'image/tiff']);
const LABEL = {
  'image/heic': 'HEIC', 'image/heif': 'HEIF', 'image/avif': 'AVIF', 'image/webp': 'WebP', 'image/gif': 'GIF',
  'image/tiff': 'TIFF', 'image/bmp': 'BMP',
};
const ACCEPTED = 'Accepted: JPEG, PNG, PDF, HEIC/HEIF, WebP, TIFF, GIF and AVIF.';

// HEIC and HEIF share a container with AVIF (ISO-BMFF, an `ftyp` box first)
// and are told apart by its brands. AVIF is asked first: an AVIF names `mif1`
// among its brands as well, and sharp reads AV1 where it cannot read HEVC.
const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx']);
const HEIF_BRANDS = new Set(['heim', 'heis', 'mif1', 'msf1']);

function _brands(buffer) {
  if (buffer.length < 16 || buffer.toString('latin1', 4, 8) !== 'ftyp') return null;
  const size = buffer.readUInt32BE(0);
  const end = Math.min(buffer.length, size >= 16 ? size : 16, 1024);
  const brands = [buffer.toString('latin1', 8, 12)];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(buffer.toString('latin1', i, i + 4));
  return brands;
}

// What the bytes are, or null. The exact signatures are asked before PDF's,
// which may sit anywhere in the first kilobyte and so could be found inside
// another format's header; BMP's two letters come last for the same reason.
function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  const brands = _brands(buffer);
  if (brands) {
    if (brands.some(b => AVIF_BRANDS.has(b))) return 'image/avif';
    if (brands.some(b => HEIC_BRANDS.has(b))) return 'image/heic';
    if (brands.some(b => HEIF_BRANDS.has(b))) return 'image/heif';
    return null;
  }
  const head = buffer.toString('latin1', 0, 12);
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (['II*\0', 'MM\0*', 'II+\0', 'MM\0+'].some(sig => head.startsWith(sig))) return 'image/tiff';
  if (buffer.subarray(0, 1024).includes('%PDF-')) return 'application/pdf';
  if (head.startsWith('BM')) return 'image/bmp';
  return null;
}

// The kinds this module turns into a JPEG or PDF, for a reader of zips that
// wants to keep them (claims/claim-archive.js). Null for anything else.
function convertibleMime(buffer) {
  const mime = sniff(buffer);
  return CONVERT.has(mime) ? mime : null;
}

const mb = n => `${(n / 1024 / 1024).toFixed(1)}MB`;
function _what(filename, declaredMime) {
  if (filename) return `"${path.basename(String(filename)).slice(0, 80)}"`;
  if (declaredMime) return `That file (${String(declaredMime).slice(0, 60)})`;
  return 'That file';
}

// Returns { buffer, mime, convertedFrom, note }: the bytes to store, what they
// are, the type they were converted from (null when kept as they came), and a
// sentence for the person when something was left out. Throws an HttpError
// whose message can be shown as it is.
async function toStorable(buffer, { declaredMime = null, filename = null } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(400, 'The file is empty.');
  if (buffer.length > MAX_BYTES) throw new HttpError(413, `The file is ${mb(buffer.length)}; the limit is ${mb(MAX_BYTES)}.`);
  const mime = sniff(buffer);
  if (KEEP.has(mime)) return { buffer, mime, convertedFrom: null, note: null };
  // A browser converts a BMP itself before sending it; one that arrives here
  // came round the page, and is refused like anything else unknown.
  if (mime === 'image/bmp') throw new HttpError(400, `BMP images are not accepted. ${ACCEPTED}`);
  if (!CONVERT.has(mime)) throw new HttpError(400, `${_what(filename, declaredMime)} is not a receipt file Solv can read. ${ACCEPTED}`);

  const sharp = loadSharp();
  if (!sharp) throw new HttpError(400, `This server cannot convert ${LABEL[mime]} files just now. Send the receipt as a JPEG, PNG or PDF.`);
  try {
    const out = await _convert(sharp, buffer, mime);
    if (out.buffer.length > MAX_BYTES) {
      throw new HttpError(413, `Converted, the ${LABEL[mime]} file is ${mb(out.buffer.length)}; the limit is ${mb(MAX_BYTES)}. Send fewer pages at a time.`);
    }
    return { ...out, convertedFrom: mime };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.warn('A receipt could not be converted', { mime, error: err.message });
    throw new HttpError(400, `${_what(filename, declaredMime)} could not be read as a ${LABEL[mime]} image. Save it again as a JPEG or PDF and send that.`);
  }
}

async function _convert(sharp, buffer, mime) {
  if (mime === 'image/heic' || mime === 'image/heif') {
    const { width, height, data } = await decodeHeic(buffer);
    if (!width || !height || width * height > MAX_PIXELS) throw new Error(`a HEIC image of ${width}x${height} is not a receipt`);
    const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return { buffer: await _jpeg(sharp(raw, { raw: { width, height, channels: 4 }, limitInputPixels: MAX_PIXELS })), mime: 'image/jpeg', note: null };
  }
  if (mime === 'image/tiff') {
    const meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
    if ((meta.pages || 1) > 1) return _tiffAsPdf(sharp, buffer, meta.pages);
  }
  // GIF and WebP may be animated; sharp opens the first frame unless asked
  // for more, and the first frame is the receipt.
  return { buffer: await _jpeg(sharp(buffer, { limitInputPixels: MAX_PIXELS })), mime: 'image/jpeg', note: null };
}

function _jpeg(image, { side = MAX_SIDE, quality = QUALITY } = {}) {
  return image.rotate()
    .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality })
    .toBuffer();
}

// One JPEG per page, each page of the PDF the size of its scan at the
// renderer's density.
async function _tiffAsPdf(sharp, buffer, pageCount) {
  const count = Math.min(pageCount, MAX_TIFF_PAGES);
  const note = pageCount > count
    ? `Only the first ${count} of the ${pageCount} pages in this TIFF were kept; send the rest as another file.`
    : null;
  let pdf = null;
  for (const step of PDF_STEPS) {
    const pages = [];
    for (let page = 0; page < count; page++) {
      const { data, info } = await sharp(buffer, { page, limitInputPixels: MAX_PIXELS }).rotate()
        .resize({ width: step.side, height: step.side, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: step.quality })
        .toBuffer({ resolveWithObject: true });
      pages.push({ data, width: info.width * 72 / PAGE_DPI, height: info.height * 72 / PAGE_DPI });
    }
    pdf = await _pdfOf(pages);
    if (pdf.length <= MAX_BYTES) break;
  }
  return { buffer: pdf, mime: 'application/pdf', note };
}

// pdfmake has one page size per document, so the document takes the first
// page's and every page after it turns to its own orientation. A scanner's
// pages are all one size, which is the case this is for.
function _pdfOf(pages) {
  const first = pages[0];
  const doc = {
    pageSize: { width: first.width, height: first.height },
    pageMargins: [0, 0, 0, 0],
    defaultStyle: { font: 'Helvetica' },
    content: pages.map((p, i) => {
      const landscape = p.width > p.height;
      const firstLandscape = first.width > first.height;
      // Turning the page swaps the document's width and height.
      const box = landscape === firstLandscape ? [first.width, first.height] : [first.height, first.width];
      return {
        image: `data:image/jpeg;base64,${p.data.toString('base64')}`,
        fit: box,
        ...(i ? { pageBreak: 'before', pageOrientation: landscape ? 'landscape' : 'portrait' } : {}),
      };
    }),
  };
  return require('../reports/expense-export').pdfBuffer(doc);
}

// HEIC is decoded in a worker thread (intake/heic-worker.js), because the
// decoder blocks whatever thread it runs on for about a second per photo.
// Tests decode in-process, where jest can stand in for the decoder; they ask
// for the worker with HEIC_IN_WORKER=1.
const HEIC_TIMEOUT_MS = 60 * 1000;
const _inWorker = () => (process.env.HEIC_IN_WORKER ? process.env.HEIC_IN_WORKER === '1' : process.env.NODE_ENV !== 'test');
function decodeHeic(buffer) {
  if (!_inWorker()) return require('heic-decode')({ buffer });
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    // The worker is given no environment: it opens a stranger's file, and
    // has no use for the server's secrets (see pdf/workers.js). libheif
    // prints its complaints about a bad file to stderr, which is not a log;
    // what went wrong comes back as the error.
    const worker = new Worker(path.join(__dirname, 'heic-worker.js'), { workerData: { buffer }, env: {}, stdout: true, stderr: true });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('HEIC decoding took too long')), HEIC_TIMEOUT_MS);
    timer.unref();
    worker.once('message', msg => (msg && msg.error ? finish(reject, new Error(msg.error)) : finish(resolve, msg)));
    worker.once('error', err => finish(reject, err));
    worker.once('exit', code => finish(reject, new Error(`the HEIC decoder stopped (${code})`)));
  });
}

module.exports = { toStorable, sniff, convertibleMime, decodeHeic, ACCEPTED, MAX_SIDE, MAX_TIFF_PAGES, KEEP, CONVERT };
