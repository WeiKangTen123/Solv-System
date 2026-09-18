const { execFile } = require('child_process');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const logger = require('./logger');

// A scanned PDF has no text layer, so its pages are drawn to images for the
// vision reader. Rendering runs in a child process (see the .mjs worker) with
// a hard timeout; a failure returns null and the receipt stays typeable.
const WORKER     = path.join(__dirname, 'pdf-render-worker.mjs');
const DPI        = 150;    // legible small print on a folio; ~1240 px wide for A4
const MAX_PAGES  = 20;
const TIMEOUT_MS = 90_000;

async function renderPdfPages(buffer, { dpi = DPI, maxPages = MAX_PAGES, timeoutMs = TIMEOUT_MS } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  const dir   = fs.mkdtempSync(path.join(os.tmpdir(), 'solv-render-'));
  const input = path.join(dir, 'in.pdf');
  try {
    fs.writeFileSync(input, buffer);
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, [WORKER, input, dir, String(dpi), String(maxPages)],
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, out, stderr) => (err ? reject(new Error(`${err.message}${stderr ? ` — ${String(stderr).slice(0, 300)}` : ''}`)) : resolve(out)));
    });
    const result = JSON.parse(String(stdout).trim().split('\n').pop());
    const pages  = result.rendered.map(p => ({ page: p.page, width: p.width, height: p.height, buffer: fs.readFileSync(p.file) }));
    return { numPages: result.numPages, pages };
  } catch (err) {
    logger.warn('PDF render failed', { error: err.message });
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { renderPdfPages, DPI, MAX_PAGES };
