const yauzl  = require('yauzl');
const logger = require('../utils/logger');

// Opens a .zip of receipt images in memory.
//
// Real claim archives are made on a Mac, so they carry a __MACOSX/ shadow tree
// of AppleDouble metadata files that mirror every real entry. Reading those as
// receipts would double the count and send junk to the model.
//
// Nothing is written to disk here — entries come back as buffers for the caller
// to store through receipt-store, which already enforces the type and size rules.

// Mirrors receipt-store's accepted types: anything else cannot become a Xero
// attachment, so there is no point extracting it.
const IMAGE_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

// A claim archive of more than this is a mistake, not a claim. Each entry costs
// a vision call, so an unbounded archive is an unbounded bill.
const MAX_ENTRIES = 100;
const MAX_ENTRY_BYTES = 15 * 1024 * 1024;   // before compression to ≤3MB
// A per-file cap is not a budget: 100 files of 15MB is 1.5GB held in memory at
// once, and a zip that compresses that well is a few megabytes to upload. The
// route caps what arrives; this caps what it can become.
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

function mimeFor(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return IMAGE_EXT[ext] || null;
}

// macOS metadata, hidden files, and directory entries.
function isJunk(name) {
  return name.startsWith('__MACOSX/')
      || name.split('/').some(part => part.startsWith('._') || part === '.DS_Store')
      || name.endsWith('/');
}

// Returns { entries: [{ name, mime, buffer }], skipped: [...] }. Never throws —
// a corrupt archive yields no entries and a reason, so an import can report it
// rather than dying.
function readArchive(buffer) {
  return new Promise(resolve => {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      return resolve({ entries: [], skipped: [], error: 'empty archive' });
    }

    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        logger.warn('Claim archive could not be opened', { error: err && err.message });
        return resolve({ entries: [], skipped: [], error: 'not a readable zip' });
      }

      const entries = [];
      const skipped = [];
      let unpacked = 0;

      zip.on('entry', entry => {
        const name = entry.fileName;

        if (isJunk(name)) return zip.readEntry();
        if (entries.length >= MAX_ENTRIES) { skipped.push({ name, reason: 'archive limit reached' }); return zip.readEntry(); }

        const mime = mimeFor(name);
        if (!mime) { skipped.push({ name, reason: 'not a receipt file type' }); return zip.readEntry(); }
        if (entry.uncompressedSize > MAX_ENTRY_BYTES) { skipped.push({ name, reason: 'file too large' }); return zip.readEntry(); }
        if (unpacked + entry.uncompressedSize > MAX_TOTAL_BYTES) { skipped.push({ name, reason: 'the archive unpacks to more than the limit' }); return zip.readEntry(); }
        unpacked += entry.uncompressedSize;

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) { skipped.push({ name, reason: 'could not be read' }); return zip.readEntry(); }
          const chunks = [];
          stream.on('data', c => chunks.push(c));
          stream.on('error', () => { skipped.push({ name, reason: 'could not be read' }); zip.readEntry(); });
          stream.on('end', () => {
            entries.push({ name, mime, buffer: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });

      zip.on('end',   () => resolve({ entries, skipped, error: null }));
      zip.on('error', e => resolve({ entries, skipped, error: e.message }));
      zip.readEntry();
    });
  });
}

module.exports = { readArchive, mimeFor, isJunk, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES };
