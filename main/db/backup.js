// Copies the live SQLite DB to data/backups/<kind>-<timestamp>.db using
// better-sqlite3's online backup API (safe against a concurrently-open,
// concurrently-written DB — unlike a plain file copy, which can grab a
// half-written page mid-write), then prunes old copies so this can't quietly
// fill the disk the way the old unrotated log files did.
//
// Three kinds, kept apart because they are kept for different reasons:
//   app-        the daily cron copy: every one from the last KEEP_DAYS days
//   predeploy-  taken by deploy.sh before every restart: the newest KEEP_PREDEPLOY
//   pull-       taken by backup-pull.sh before it copies the set off the box
// They used to share one count of 14, and a busy day of deploys pushed every
// daily copy out: "two weeks of backups" was a day and a half.
//
// The copy is written under a .tmp name, opened and checked with
// integrity_check, and only then renamed into place: a backup that would not
// open is worse than none, because it looks like one, and a run killed
// part-way must not leave a half-file that `ls -t` would pick.
//
// Usage: node db/backup.js [--kind app|predeploy|pull]
//
// Scheduled by deploy.sh as a daily cron job on the box, and run by it before
// every restart. `npm run backup:pull` copies a fresh backup, the per-user
// files and .env off the box — see docs/RUNBOOK.md for the restore.

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

const KINDS = ['app', 'predeploy', 'pull'];
const KEEP_DAYS = 14;      // daily copies: two weeks of them
const KEEP_MIN = 3;        // ...but never fewer than this, however old: a cron that stopped must not leave nothing
const KEEP_PREDEPLOY = 5;  // the last few deploys, to step back from a bad one
const KEEP_PULL = 2;       // the box's own copy of a pull; the real one is off the box
// The script runs beside the live server. Nothing it does should take minutes;
// if it does, something is wrong, and a deploy waiting on it must hear so.
const TIMEOUT_MS = 10 * 60 * 1000;

const _stamp = f => {
  const m = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/.exec(f);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
};

function _prune(dir, now = Date.now()) {
  const all = fs.readdirSync(dir);
  for (const kind of KINDS) {
    // ISO timestamps in the filename sort chronologically as strings; newest first.
    const files = all.filter(f => f.startsWith(`${kind}-`) && f.endsWith('.db')).sort().reverse();
    const doomed = kind === 'app'
      ? files.filter((f, i) => i >= KEEP_MIN && !(now - _stamp(f) < KEEP_DAYS * 86400000))
      : files.slice(kind === 'predeploy' ? KEEP_PREDEPLOY : KEEP_PULL);
    for (const f of doomed) {
      fs.unlinkSync(path.join(dir, f));
      console.log(`Pruned old backup ${f}`);
    }
  }
  // A .tmp left by a run that was killed part-way is never a backup.
  for (const f of all.filter(f => f.endsWith('.db.tmp'))) {
    try { if (now - fs.statSync(path.join(dir, f)).mtimeMs > TIMEOUT_MS) fs.unlinkSync(path.join(dir, f)); } catch { /* gone already */ }
  }
}

// Returns the path of the verified backup. `db` and `destDir` are arguments
// so a test can back up a temp file database; production callers pass none.
async function run({ db: source, destDir, kind = 'app' } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown backup kind "${kind}" (${KINDS.join(', ')})`);
  source = source || require('./index');
  destDir = destDir || require('../utils/paths').backupsDir();
  if (source.path === ':memory:') {
    console.log('In-memory DB (test mode) — nothing to back up.');
    return null;
  }
  fs.mkdirSync(destDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest  = path.join(destDir, `${kind}-${stamp}.db`);
  const tmp   = `${dest}.tmp`;

  // All pages in one step. The default copies 100 pages a step, and SQLite
  // starts the copy over whenever another connection writes between steps;
  // with the live server writing every few hundred milliseconds a 59 MB
  // database restarted 141 times in 30 seconds and never finished.
  await source.backup(tmp, { progress: () => 0x7fffffff });

  // The backup inherits WAL mode from the source, which leaves -wal/-shm sidecar
  // files next to it — a backup isn't really "one file" until those are folded
  // back in. Switching the copy to DELETE mode checkpoints and removes them,
  // leaving a single portable .db file.
  // Closed in `finally`: a copy that is not a database throws out of the
  // first pragma, and a handle left open on it made the unlink below fail
  // quietly, leaving the bad file on disk looking like a backup.
  let result, copy = null;
  try {
    copy = new Database(tmp);
    copy.pragma('journal_mode = DELETE');
    result = copy.pragma('integrity_check', { simple: true });
  } catch (err) {
    result = err.message;
  } finally {
    try { if (copy) copy.close(); } catch { /* already closed or never opened */ }
  }
  if (result !== 'ok') {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) { try { fs.unlinkSync(f); } catch {} }
    throw new Error(`Backup failed integrity_check: ${result}`);
  }
  fs.renameSync(tmp, dest);

  _prune(destDir);
  // Last, so a caller reading only the final line still finds it: deploy.sh
  // used to, and the first prune message after the fourteenth backup made
  // every deploy stop here.
  console.log(`Backed up DB to ${dest}`);
  return dest;
}

if (require.main === module) {
  // Here, not at the top: a test that loads this module must not read a
  // developer's own main/.env. DATA_DIR in it decides where backups go.
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  const i = process.argv.indexOf('--kind');
  const kind = i > 0 ? process.argv[i + 1] : 'app';
  const timer = setTimeout(() => { console.error(`Backup failed: still running after ${TIMEOUT_MS / 60000} minutes`); process.exit(1); }, TIMEOUT_MS);
  timer.unref();
  run({ kind }).catch(err => {
    console.error('Backup failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { run, KINDS, KEEP_DAYS, KEEP_MIN, KEEP_PREDEPLOY, KEEP_PULL, _prune };
