const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const workers = require('./workers');

// The text layer of a PDF, read in a child process with a hard timeout (see
// text-worker.mjs). This used to run in the server itself through pdf-parse,
// which bundles a PDF engine from 2017, on every uploaded PDF: one crafted
// file could hang every request. Throws on failure; pages.js decides what a
// failure means.
const WORKER     = path.join(__dirname, 'text-worker.mjs');
const TIMEOUT_MS = 30_000;
const MAX_PAGES  = 50;

async function extractText(buffer, opts = {}) {
  return require('./slots').withSlot(() => _extract(buffer, opts));
}
async function _extract(buffer, { timeoutMs = TIMEOUT_MS, maxPages = MAX_PAGES } = {}) {
  const dir   = workers.tempDir('text');
  const input = path.join(dir, 'in.pdf');
  try {
    fs.writeFileSync(input, buffer);
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, [WORKER, input, String(maxPages)],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: workers.childEnv() },
        (err, out, stderr) => (err ? reject(new Error(`${err.killed ? 'timed out' : err.message}${stderr ? ` — ${String(stderr).slice(0, 300)}` : ''}`)) : resolve(out)));
    });
    const result = JSON.parse(String(stdout).trim().split('\n').pop());
    return { numPages: Number(result.numPages) || 0, pages: Array.isArray(result.pages) ? result.pages.map(String) : [] };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

module.exports = { extractText, TIMEOUT_MS, MAX_PAGES };
