const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const logger = require('../utils/logger');

// What a PDF worker process (render-worker.mjs, text-worker.mjs) is given, and
// the temp folders the workers leave behind.
//
// A worker opens whatever PDF a stranger uploaded. It used to inherit the
// server's whole environment, JWT_SECRET and ENCRYPTION_KEY included, so a flaw
// in the PDF engine that let a file read process.env would have handed over
// the keys to every session and every stored Xero token. A worker is given
// only what Node needs to start and find a temp folder, on Windows and Linux.
const KEEP = ['PATH', 'SystemRoot', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'NODE_ENV', 'LANG', 'LC_ALL', 'TZ'];
function childEnv() {
  const env = {};
  for (const name of KEEP) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

// Each read works in a folder of its own under the system temp folder, removed
// when the read ends. A server that exits during a read (a deploy, a crash)
// leaves its folder behind, and a copy of somebody's receipt in it. sweepStaleTemp
// runs at boot: a folder of ours older than an hour is from a read that cannot
// still be running, since no worker is given more than 90 seconds.
const PREFIX = { render: 'solv-render-', text: 'solv-text-' };
const HOUR = 60 * 60 * 1000;

function tempDir(kind) { return fs.mkdtempSync(path.join(os.tmpdir(), PREFIX[kind])); }

// Returns how many folders were removed. Never throws: a folder that cannot be
// removed now is tried again at the next boot.
function sweepStaleTemp({ olderThanMs = HOUR, dir = os.tmpdir(), now = Date.now() } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const ours = Object.values(PREFIX);
  let removed = 0;
  for (const name of names) {
    if (!ours.some(p => name.startsWith(p))) continue;
    const full = path.join(dir, name);
    try {
      // lstat, so a link that merely carries our name is never followed.
      const st = fs.lstatSync(full);
      if (!st.isDirectory() || now - st.mtimeMs < olderThanMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch { /* gone already, or not ours to remove */ }
  }
  if (removed) logger.info('Removed PDF temp folders left by an earlier run', { removed });
  return removed;
}

module.exports = { childEnv, tempDir, sweepStaleTemp, PREFIX };
