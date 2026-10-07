const logger = require('../utils/logger');

// sharp, set up once for every image job on receipts: the reader's shrinking
// (image-prep.js) and the pairing thumbnails (thumbnailer.js). Each used to
// load and configure its own copy.
//
// Loaded lazily, so that requiring a module that uses it, which the receipts
// route does at startup, cannot fail a boot over an image library. A box that
// somehow has no working sharp gets null, and every caller then uses the
// original image instead of nothing.
let _sharp;
let _failed = false;
function loadSharp() {
  if (_failed) return null;
  if (!_sharp) {
    try {
      _sharp = require('sharp');
      // libvips sizes its thread pool to the CPU count by default. Shrinking a
      // receipt is not work worth parallelising, and the server this runs on
      // has two cores it also needs for serving requests, so one image cannot
      // take the box with it. It also keeps the test run honest: several jest
      // workers each spawning a CPU-sized pool oversubscribes the machine
      // badly enough to disturb unrelated suites.
      _sharp.concurrency(1);
      // libvips caches recent operations, which keeps their input files open.
      // An image is processed once and never revisited, so the cache buys
      // nothing here, and an open handle on the original stops a re-read or
      // rotate from writing the file back in place on Windows.
      _sharp.cache(false);
    } catch (err) {
      _failed = true;
      logger.warn('sharp unavailable — receipts will be served and read at full size', { error: err.message });
      return null;
    }
  }
  return _sharp;
}

module.exports = { loadSharp };
