// Preparing a receipt for upload.
//
// Xero rejects attachments over 3MB, and a phone photo is routinely 4-12MB, so
// the image is resized and re-encoded IN THE BROWSER before it is ever sent.
// Doing it here rather than on the server also means the user's mobile data
// carries 800KB instead of 12MB.
//
// PDFs pass through untouched: there is no raster to resize, and re-encoding
// one would destroy the text layer the parser depends on.
//
// Some photos the browser cannot draw at all: HEIC from an iPhone in Chrome
// or Firefox on a computer, AVIF in an older browser, and TIFF almost
// everywhere. The server converts those itself (main/intake/convert.js), so
// they are sent as they are, named for what they are. They used to be refused
// here with "HEIC photos only open in Safari".
//
// No imports, so main/scripts/ui-intake-logic.test.js can load it from source.

export const MAX_BYTES = 3 * 1024 * 1024;
// PDFs are not re-encoded; the server keeps originals up to this size.
export const MAX_PDF_BYTES = 15 * 1024 * 1024;
// A file sent as it is for the server to convert: the server's own limit for
// one receipt (receipts/receipt-store.js MAX_BYTES).
export const MAX_RAW_BYTES = 15 * 1024 * 1024;
export const ACCEPTED  = ['image/jpeg', 'image/png', 'application/pdf'];
// What the FILE PICKER offers. Wider than what Xero accepts on purpose: every
// image here ends up a JPEG, re-encoded here or converted on the server, so
// Xero only ever sees a format it takes. A zip of receipts, a saved email
// (.eml, or Outlook's .msg) and an .xlsx claim form are offered too, for the
// New case page and the case page, which send them on to the zip, email and
// claim-import routes. Extensions as well as types, because Windows gives a
// .heic, a .tif or an .eml no type at all and the picker would grey it out.
export const ACCEPT_ATTR = [
  'image/*', 'image/heic', 'image/heif', 'image/tiff', 'image/avif', 'image/webp', 'image/gif', 'image/bmp',
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.avif', '.webp', '.gif', '.bmp', '.pdf', '.zip', '.xlsx', '.eml', '.msg',
  'application/pdf', 'application/zip', 'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'message/rfc822', 'application/vnd.ms-outlook',
].join(',');
// For a picker of single receipts (the phone's capture page): photos and PDFs,
// no zips or claim forms, which only the New case page knows what to do with.
export const PHOTO_ACCEPT_ATTR = 'image/*,.heic,.heif,.tif,.tiff,.avif,.pdf,application/pdf';

// Long edge. 2000px keeps small print on a receipt legible for the parser while
// landing a typical photo comfortably under the cap.
const MAX_DIM = 2000;
// Tried in order until the result fits. Stopping at 0.5 rather than going lower
// because past that the numbers on a receipt start to smear.
const QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5];

const BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  avif: 'image/avif', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
};
// The kinds the server turns into a JPEG (or a TIFF of several pages into a
// PDF), and so may be sent untouched when the browser cannot draw them.
const SERVER_CONVERTS = new Set(['image/heic', 'image/heif', 'image/tiff', 'image/avif']);
const LABEL = { 'image/heic': 'HEIC photo', 'image/heif': 'HEIF photo', 'image/tiff': 'TIFF', 'image/avif': 'AVIF photo' };

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// An error that says what kind of refusal it is, so the uploader can show a
// file that is too big apart from one that is not a receipt at all.
function refusal(kind, message) {
  return Object.assign(new Error(message), { kind });
}

// What the file says it is: its type, or, when the browser gave none (Windows
// does that for .heic and .tif), what its extension means. Lower case, and
// image/jpg read as the image/jpeg it means.
export function declaredMime(file) {
  const type = String((file && file.type) || '').toLowerCase();
  if (type && type !== 'application/octet-stream') return type === 'image/jpg' ? 'image/jpeg' : type;
  const ext = /\.([a-z0-9]+)$/i.exec(String((file && file.name) || ''));
  return (ext && BY_EXT[ext[1].toLowerCase()]) || '';
}

// Whether the server would take this file as it is when the browser cannot
// draw it.
export function serverConverts(file) {
  return SERVER_CONVERTS.has(declaredMime(file));
}

function canvasToBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', quality));
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // Result is a data: URI; the server accepts the prefix and strips it.
    reader.onload  = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(blob);
  });
}

function asIs(file, mime) {
  if (file.size > MAX_RAW_BYTES) {
    throw refusal('too-big', `This ${LABEL[mime] || 'file'} is ${humanSize(file.size)}; the limit is ${humanSize(MAX_RAW_BYTES)}.`);
  }
  return { blob: file, mime, originalBytes: file.size, bytes: file.size, raw: true };
}

// The picture in the file, upright, or null when this browser cannot draw it.
async function decode(file) {
  try {
    // imageOrientation MUST be explicit. A phone stores a portrait photo as
    // landscape pixels plus an EXIF "rotate 90" flag, and browsers disagree on
    // whether createImageBitmap honours that flag by default — the option has
    // been specified as both "none" and "from-image" over time. Left implicit,
    // the same receipt comes out upright in one browser and on its side in
    // another, and a sideways receipt is markedly harder for the parser to read
    // AND yields rotated bounding boxes, which then breaks the split guards.
    //
    // Passing it explicitly makes the result the same everywhere. The returned
    // bitmap is already rotated, so width/height below are the upright ones.
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // A browser that rejects the options bag rather than ignoring it still gets
    // a usable image, just without the guaranteed rotation.
    try { return await createImageBitmap(file); } catch { return null; }
  }
}

// Returns { blob, mime, originalBytes, bytes, raw?, convertedFrom? } or throws with a message
// that says what the user should do next, and `kind` 'too-big' or
// 'unsupported'. `raw` is set when the file goes as it is.
export async function prepareReceipt(file) {
  if (!file) throw refusal('unsupported', 'No file selected');
  const originalBytes = file.size;
  const mime = declaredMime(file);

  if (mime === 'application/pdf') {
    if (originalBytes > MAX_PDF_BYTES) {
      throw refusal('too-big', `This PDF is ${humanSize(originalBytes)}; the limit is ${humanSize(MAX_PDF_BYTES)}.`);
    }
    return { blob: file, mime: 'application/pdf', originalBytes, bytes: originalBytes, raw: true };
  }
  // A TIFF from a scanner often holds several pages. A browser that can draw
  // one draws only its first page, so it always goes to the server, which
  // keeps every page (as a PDF).
  if (mime === 'image/tiff') return asIs(file, mime);

  // Anything the browser can decode is fair game as INPUT — including HEIC on
  // iOS, which decodes natively. Re-encoding to JPEG keeps the upload small.
  const bitmap = await decode(file);
  if (!bitmap) {
    if (SERVER_CONVERTS.has(mime)) return asIs(file, mime);
    if (/zip|spreadsheet|excel/.test(mime)) {
      throw refusal('unsupported', 'A zip or a claim form is added on the computer, on the New case page.');
    }
    throw refusal('unsupported', 'That file could not be read as an image. Try a JPEG, PNG or PDF.');
  }

  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width  = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency, and a canvas starts clear: a PNG's transparent
  // background was encoded as black, with the receipt's black print on it.
  // White paper goes down first.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();

  for (const quality of QUALITY_STEPS) {
    const blob = await canvasToBlob(canvas, quality);
    if (blob && blob.size <= MAX_BYTES) {
      // What it was, when that was not already a JPEG or PNG, so the receipt
      // says "converted from WebP" as one the server converted does.
      const convertedFrom = mime && mime !== 'image/jpeg' && mime !== 'image/png' ? mime : null;
      return { blob, mime: 'image/jpeg', originalBytes, bytes: blob.size, convertedFrom };
    }
  }
  throw refusal('too-big', `This image is still over ${humanSize(MAX_BYTES)} after compression. Try photographing just the receipt, closer in.`);
}

// POSTs JSON to the API and reports how much of the body has gone, which
// fetch cannot do: a 12 MB PDF on a phone's upload link takes long enough
// that "uploading" with no number on it looks stuck. `path` starts after /api,
// as with api/client.js.
//
// Resolves { status, body } for any answer the server gave, a refusal
// included, so the caller can read a 409's details (which duplicate, a claim
// form in a zip) that api/client.js does not pass on. Rejects only when
// nothing came back (kind 'network') or the upload was stopped
// (kind 'aborted'). `signal` is an AbortSignal.
export function postWithProgress(path, body, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    const token = localStorage.getItem('token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (onProgress) xhr.upload.onprogress = e => { if (e.lengthComputable && e.total) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}') || {}; } catch { data = {}; }
      resolve({ status: xhr.status, body: data });
    };
    xhr.onerror = () => reject(refusal('network', 'The connection dropped before the file arrived. Try again.'));
    xhr.onabort = () => reject(refusal('aborted', 'Stopped'));
    if (signal) {
      if (signal.aborted) { reject(refusal('aborted', 'Stopped')); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(JSON.stringify(body));
  });
}
