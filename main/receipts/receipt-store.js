const fs   = require('fs');
const path = require('path');

// Per-user receipt files for expense claims, on disk beside the PDF store.
//
// Deliberately a sibling of pdf-store.js rather than a generalisation of it: a
// bill's PDF and an expense claim's receipt have different lifecycles, different
// accepted types, and reach Xero by different paths. Merging them would save a
// few lines and cost the ability to reason about either.
//
// Unlike pdf-store the extension varies, so the stored filename is returned by
// save() and recorded on the invoice row — callers must not reconstruct it.
const BASE_DIR = require('../utils/paths').usersDir();
const _stores  = new Map();

// What Xero's Files API accepts, which is the real constraint — storing a type
// Xero will later reject just moves the failure somewhere less useful.
const MIME_EXT = {
  'image/jpeg':      'jpg',
  'image/png':       'png',
  'application/pdf': 'pdf',
};

// Originals are kept at full size. Xero's 3 MB attachment limit applies to the
// copy made when a report is posted, not to storage.
const MAX_BYTES = 15 * 1024 * 1024;

function extensionFor(mime) { return MIME_EXT[String(mime || '').toLowerCase()] || null; }
function isAcceptedMime(mime) { return extensionFor(mime) !== null; }
function acceptedMimes() { return Object.keys(MIME_EXT); }

// What the bytes actually are, from their first few, or null. The type a
// browser or a zip entry's name declares is a claim; this is the check. A
// file whose content does not match what it says it is never stored.
function sniffMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  // %PDF- may sit after a little leading junk; readers accept it within 1 KB.
  if (buffer.subarray(0, 1024).includes('%PDF-')) return 'application/pdf';
  return null;
}
function contentMatches(buffer, mime) { return sniffMime(buffer) === String(mime || '').toLowerCase(); }

// How much one person may keep. A receipt is at most 15 MB, so this is room
// for a few hundred of the largest, and stops one account filling the disk.
const QUOTA_BYTES = Math.max(50, Number(process.env.RECEIPT_QUOTA_MB) || 2048) * 1024 * 1024;

function forUser(userId) {
  if (_stores.has(userId)) return _stores.get(userId);

  const DIR = path.join(BASE_DIR, String(userId), 'receipts');
  function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

  // Returns the stored filename, which the caller persists on the invoice row.
  function save(id, buffer, mime) {
    const ext = extensionFor(mime);
    if (!ext) throw new Error(`Unsupported receipt type: ${mime}`);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Receipt file is empty');
    if (buffer.length > MAX_BYTES) throw new Error(`Receipt is ${buffer.length} bytes; the limit is ${MAX_BYTES}`);

    ensureDir();
    const filename = `${id}.${ext}`;
    fs.writeFileSync(path.join(DIR, filename), buffer);
    return filename;
  }

  // Null rather than a throw when absent: a missing file is a normal state (the
  // row can outlive the image), and callers render a placeholder for it.
  function getPath(filename) {
    if (!filename || String(filename).includes('/') || String(filename).includes('..')) return null;
    const p = path.join(DIR, filename);
    return fs.existsSync(p) ? p : null;
  }

  function read(filename) {
    const p = getPath(filename);
    return p ? fs.readFileSync(p) : null;
  }

  function exists(filename) { return getPath(filename) !== null; }

  // Cached thumbnails sit beside the original as "<filename>.w<width>.jpg", so
  // they are swept by prefix here rather than tracked in an index that could
  // drift out of step with the files themselves.
  function removeDerivatives(filename) {
    if (!filename) return 0;
    let n = 0;
    try {
      for (const f of fs.readdirSync(DIR)) {
        if (f.startsWith(`${filename}.w`) && f.endsWith('.jpg')) {
          try { fs.unlinkSync(path.join(DIR, f)); n++; } catch (_) { /* already gone */ }
        }
      }
    } catch (_) { /* no directory yet */ }
    return n;
  }

  function remove(filename) {
    const p = getPath(filename);
    // Swept whether or not the original is still present, so a receipt that was
    // half-deleted earlier cannot leave thumbnails behind for good.
    removeDerivatives(filename);
    if (!p) return false;
    fs.unlinkSync(p);
    return true;
  }

  function clearAll() {
    ensureDir();
    for (const f of fs.readdirSync(DIR)) {
      try { fs.unlinkSync(path.join(DIR, f)); } catch {}
    }
  }

  const store = { save, getPath, read, exists, remove, removeDerivatives, clearAll, dir: DIR };
  _stores.set(userId, store);
  return store;
}

module.exports = { forUser, extensionFor, isAcceptedMime, acceptedMimes, sniffMime, contentMatches, MAX_BYTES, QUOTA_BYTES, MIME_EXT };
