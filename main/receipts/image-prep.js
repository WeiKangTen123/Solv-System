// A photo as the model is sent it. Uploads from the app arrive already
// compressed (ui/src/components/receipts/receipt-upload.js), but photos inside
// a ZIP arrive as the camera made them: 4–8 MB each, sent five to a request,
// which runs past what Google accepts in one request and pushes the batch
// back to one call per photo. A large photo is shrunk to 2400 px on its long
// side first; the reader's boxes are in 0–1000 units of the image, so the
// size does not move them, and the orientation tag is kept so the model sees
// the photo the way it saw the original.
const MAX_SIDE  = 2400;
const MIN_BYTES = 1.5 * 1024 * 1024;
const SHRINKS   = new Set(['image/jpeg', 'image/png', 'image/webp']);

let _sharp, _failed = false;
function sharp() {
  if (_failed) return null;
  if (!_sharp) {
    try { _sharp = require('sharp'); _sharp.concurrency(1); _sharp.cache(false); }
    catch { _failed = true; return null; }
  }
  return _sharp;
}

async function forModel(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_BYTES || !SHRINKS.has(mime)) return { buffer, mime };
  const s = sharp();
  if (!s) return { buffer, mime };
  try {
    const out = await s(buffer).resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .withMetadata().jpeg({ quality: 85 }).toBuffer();
    return out.length < buffer.length ? { buffer: out, mime: 'image/jpeg' } : { buffer, mime };
  } catch {
    return { buffer, mime };
  }
}

// The content part a chat message carries for one image.
async function imagePart(buffer, mime) {
  const img = await forModel(buffer, mime);
  return { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.buffer.toString('base64')}` } };
}

module.exports = { forModel, imagePart, MAX_SIDE, MIN_BYTES };
