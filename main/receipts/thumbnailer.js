const fs    = require('fs');
const path  = require('path');
const logger = require('../utils/logger');
const { loadSharp } = require('./load-sharp');

// Scaled-down copies of receipt images, cached next to the original.
//
// The pairing modal renders receipts at 76px while a stored receipt can be up
// to MAX_BYTES (3MB) — roughly forty times the data a thumbnail needs, fetched
// once per receipt while a phone is still uploading more of them.
//
// Generated on demand rather than at upload. Upload happens on a phone over
// mobile data and adding image processing to that path delays the thing the
// user is waiting for, to produce a file most receipts never need: the review
// screen wants the full image, and a receipt that is captured and posted is
// never shown as a thumbnail at all.
//
// sharp comes from load-sharp.js, loaded lazily so that requiring this module
// cannot fail a boot. A box that somehow has no working sharp serves
// originals instead of serving nothing.

// A fixed set, not an arbitrary number. A free-form ?w= lets one caller fill the
// disk with a thousand near-identical renderings of the same receipt, and every
// distinct value is a cache entry nothing will ever read again.
//   160 — the 76px pairing tile at 2x for a retina screen
//   480 — a larger preview, should one be wanted later
const WIDTHS = new Set([160, 480]);

// Only raster formats. A PDF receipt is served as-is; rasterising one needs a
// renderer this does not have, and the modal never shows PDFs anyway.
const RESIZABLE = new Set(['image/jpeg', 'image/png']);

function isResizable(mime) { return RESIZABLE.has(String(mime || '').toLowerCase()); }
function allowedWidth(w) {
  const n = Number(w);
  return WIDTHS.has(n) ? n : null;
}

// Derivatives sit beside the original with the width in the name, so the store's
// remove() can sweep them with a prefix match and no index has to be kept in
// step. Always .jpg: a thumbnail is for looking at, and PNG at this size is
// larger for no benefit anyone can see.
function derivativeName(filename, width) {
  return `${filename}.w${width}.jpg`;
}
function isDerivative(name) {
  return /\.w\d+\.jpg$/.test(String(name || ''));
}

// Returns a path to a cached thumbnail, generating it if absent. Returns null
// when one cannot be produced, and every caller treats that as "serve the
// original" rather than as an error — a slightly heavy image is a much better
// outcome than a broken one.
async function thumbnailPath(sourcePath, destDir, filename, width, mime) {
  if (!isResizable(mime)) return null;
  const w = allowedWidth(width);
  if (!w) return null;
  const lib = loadSharp();
  if (!lib) return null;

  const outPath = path.join(destDir, derivativeName(filename, w));
  try {
    // Regenerate if the original has been replaced since — a receipt can be
    // re-read or rotated in place, and a stale thumbnail would outlive it.
    const [src, cached] = [fs.statSync(sourcePath), fs.existsSync(outPath) ? fs.statSync(outPath) : null];
    if (cached && cached.mtimeMs >= src.mtimeMs) return outPath;
  } catch (_) { /* fall through and regenerate */ }

  try {
    await lib(sourcePath)
      .rotate()                                   // honour the EXIF orientation a phone camera writes
      .resize({ width: w, withoutEnlargement: true })
      .flatten({ background: '#fff' })            // a PNG's clear background, white rather than JPEG's black
      .jpeg({ quality: 78, mozjpeg: true })
      .toFile(outPath);
    return outPath;
  } catch (err) {
    logger.warn('Thumbnail generation failed — serving the original', { filename, width: w, error: err.message });
    return null;
  }
}

module.exports = { thumbnailPath, derivativeName, isDerivative, isResizable, allowedWidth, WIDTHS };
