// Is this box fit to run Solv? Answers before a deploy restarts anything, and
// on a fresh machine before the first boot.
//
// Every check here stands for a way the app has failed or would fail at boot,
// where the symptom is a process that exits and a pm2 restart loop rather than
// a sentence naming the cause: a native module built for another architecture,
// an ENCRYPTION_KEY that would make every stored credential unreadable, a data
// directory owned by root, a production server with no UI built to serve.
//
//   node main/scripts/preflight.js            check this machine
//   node main/scripts/preflight.js --json     the same, as JSON
//
// It reads; it does not migrate, write or repair. Exits 1 if anything failed,
// 0 if only warnings. Warnings are things that work but should not be true of
// a server: the fallback encryption key, self-registration left open.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, 'main/.env') });

const JSON_OUT = process.argv.includes('--json');
const PROD = process.env.NODE_ENV === 'production';
const results = [];
const ok    = (name, detail) => results.push({ name, state: 'ok', detail });
const warn  = (name, detail) => results.push({ name, state: 'warn', detail });
const fail  = (name, detail) => results.push({ name, state: 'fail', detail });
const check = (name, fn) => { try { fn(name); } catch (err) { fail(name, err.message); } };

// ── the runtime ────────────────────────────────────────────────────────────
check('Node version', () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) return fail('Node version', `${process.versions.node} — better-sqlite3 and the PDF worker are built against 22+`);
  ok('Node version', process.versions.node);
});

// Three native modules. A tarball copied between a Mac and a Linux VM, or an
// `npm install` run under a different Node, leaves these unloadable, and the
// failure arrives as a crash at require time with no other explanation.
for (const [mod, what] of [['better-sqlite3', 'the database'], ['sharp', 'thumbnails'], ['@napi-rs/canvas', 'scanned-PDF rendering']]) {
  check(`native module ${mod}`, () => {
    require(mod);
    ok(`native module ${mod}`, what);
  });
}

// ── secrets ────────────────────────────────────────────────────────────────
check('JWT_SECRET', () => {
  const v = process.env.JWT_SECRET || '';
  if (!v) return fail('JWT_SECRET', 'not set — every token this process signs would be signed with a default');
  if (v === 'change-me-to-a-long-random-string') return fail('JWT_SECRET', 'still the value from .env.example');
  if (v.length < 32) return (PROD ? fail : warn)('JWT_SECRET', `${v.length} characters — use at least 32`);
  ok('JWT_SECRET', `${v.length} characters`);
});

check('ENCRYPTION_KEY', () => {
  const v = (process.env.ENCRYPTION_KEY || '').trim();
  if (!v) return fail('ENCRYPTION_KEY', 'not set — Xero credentials and reader keys cannot be stored');
  if (!/^[0-9a-fA-F]{64}$/.test(v)) return fail('ENCRYPTION_KEY', 'must be exactly 64 hexadecimal characters');
  if (/^0+$/.test(v)) return (PROD ? fail : warn)('ENCRYPTION_KEY', 'all zeroes — the test key, not a secret');
  ok('ENCRYPTION_KEY', '64 hex characters, not the test key');
});

// ── where the data lives ───────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'main/data');
const LOGS_DIR = process.env.LOGS_DIR || path.join(ROOT, 'logs');
for (const [label, dir] of [['DATA_DIR', DATA_DIR], ['LOGS_DIR', LOGS_DIR]]) {
  check(`${label} writable`, () => {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.preflight-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    ok(`${label} writable`, dir);
  });
}

// ── the database ───────────────────────────────────────────────────────────
// Opened read-only on purpose: preflight runs against a live box, and a check
// that migrates is a change, not a check. Boot migrates.
check('database', () => {
  const dbPath = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');
  if (!fs.existsSync(dbPath)) return ok('database', `none yet at ${dbPath} — the first boot creates it`);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') return fail('database', `integrity_check says ${integrity}`);
    const version = db.pragma('user_version', { simple: true });
    const { LATEST } = require(path.join(ROOT, 'main/db/schema-version'));   // not migrate: requiring it opens and creates the database
    if (version > LATEST) return warn('database', `schema ${version} is newer than this code expects (${LATEST}) — you are deploying older code over a migrated database`);
    // A file with no tables in it is a database boot has not finished with,
    // not a broken one: a first start that stopped early, or the empty file an
    // earlier version of this script left behind. Counting users threw, and a
    // box in that state was called unfit when all it needed was to be started.
    const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    const behind = version < LATEST ? ` (boot will migrate ${version} → ${LATEST})` : '';
    if (!hasUsers) return ok('database', `empty file at schema ${version} — boot will create the schema`);
    const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    ok('database', `intact, schema ${version}${behind}, ${users} user(s)`);
  } finally { db.close(); }
});

check('backups', () => {
  const dir = path.join(DATA_DIR, 'backups');
  if (!fs.existsSync(dir)) return warn('backups', 'none taken yet — npm run backup, and the deploy installs the daily cron');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
  if (!files.length) return warn('backups', 'the directory is empty');
  const newest = files[files.length - 1];
  const age = (Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs) / 86400000;
  const line = `${files.length} kept, newest ${newest} (${age < 1 ? 'today' : `${Math.floor(age)} day(s) old`})`;
  return age > 2 ? warn('backups', line) : ok('backups', line);
});

// ── what production additionally needs ─────────────────────────────────────
check('built UI', () => {
  const index = path.join(ROOT, 'ui/dist/index.html');
  if (!fs.existsSync(index)) {
    return PROD ? fail('built UI', 'ui/dist/index.html is missing — npm run build:ui, or production serves nothing')
                : ok('built UI', 'not built; development serves the UI from vite');
  }
  const assets = path.join(ROOT, 'ui/dist/assets');
  const n = fs.existsSync(assets) ? fs.readdirSync(assets).length : 0;
  const age = (Date.now() - fs.statSync(index).mtimeMs) / 86400000;
  ok('built UI', `${n} assets, built ${age < 1 ? 'today' : `${Math.floor(age)} day(s) ago`}`);
});

check('fonts are self-hosted', () => {
  // The CSP allows fonts from this origin only. Missing files do not fail a
  // build; they fall back to a system face, which is visible only to whoever
  // opens the page.
  const dir = path.join(ROOT, 'ui/public/fonts');
  const n = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(woff2?|ttf)$/.test(f)).length : 0;
  return n ? ok('fonts are self-hosted', `${n} files`) : warn('fonts are self-hosted', 'none in ui/public/fonts — the CSP blocks Google Fonts, so text falls back to a system face');
});

check('reader key', () => {
  if (process.env.Gemini_API_KEY) return ok('reader key', 'Gemini_API_KEY set as the company fallback');
  warn('reader key', 'no Gemini_API_KEY — each company must add its own in Settings or no receipt can be read');
});

check('self-registration', () => {
  const open = String(process.env.ALLOW_REGISTRATION || '').toLowerCase() === 'true';
  if (!open) return ok('self-registration', 'closed — only an admin can add staff');
  return PROD ? warn('self-registration', 'ALLOW_REGISTRATION=true on a production box: anyone who reaches the URL can create an account')
              : ok('self-registration', 'open (development)');
});

check('Xero redirect URI', () => {
  const uri = process.env.XERO_OAUTH_REDIRECT_URI;
  if (!uri) return PROD ? warn('Xero redirect URI', 'unset — the OAuth round trip cannot complete until it matches the URI registered on the Xero app')
                        : ok('Xero redirect URI', 'unset (development)');
  if (!/^https:\/\//.test(uri)) return fail('Xero redirect URI', 'Xero refuses a non-HTTPS callback');
  if (!/\/api\/xero\/oauth\/callback$/.test(uri)) return warn('Xero redirect URI', `does not end in /api/xero/oauth/callback: ${uri}`);
  ok('Xero redirect URI', uri);
});

check('crash alerts', () => {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (url) return /^https:\/\//.test(url) ? ok('crash alerts', 'Slack webhook set') : fail('crash alerts', 'SLACK_WEBHOOK_URL is not an https URL');
  return PROD ? warn('crash alerts', 'no SLACK_WEBHOOK_URL — a fatal exit restarts silently')
              : ok('crash alerts', 'none (development)');
});

check('disk space', () => {
  // Receipts are kept as files; a full disk corrupts nothing but stops every
  // upload, and SQLite's WAL needs room to check point.
  // execFileSync, not execSync: the path is interpolated into no shell at all.
  // Quoting it with JSON.stringify produced double quotes, inside which a
  // DATA_DIR holding $(...) was executed by the shell rather than measured.
  const out = require('child_process').execFileSync('df', ['-Pk', DATA_DIR], { encoding: 'utf8' }).trim().split('\n').pop().split(/\s+/);
  const freeGb = Number(out[3]) / 1048576;
  const line = `${freeGb.toFixed(1)} GB free on the volume holding DATA_DIR`;
  if (freeGb < 1) return fail('disk space', line);
  if (freeGb < 5) return warn('disk space', line);
  ok('disk space', line);
});

// ── report ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => r.state === 'fail');
const warned = results.filter(r => r.state === 'warn');

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: !failed.length, env: process.env.NODE_ENV || 'development', results }, null, 2));
} else {
  const mark = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };
  console.log(`\nPreflight — ${process.env.NODE_ENV || 'development'}\n`);
  for (const r of results) console.log(`  ${mark[r.state]} ${r.name.padEnd(26)} ${r.detail}`);
  console.log();
  if (failed.length) console.log(`\x1b[31m✗ ${failed.length} check(s) failed\x1b[0m — this box is not ready to run Solv`);
  else if (warned.length) console.log(`\x1b[32m✓ ready\x1b[0m, with ${warned.length} warning(s)`);
  else console.log('\x1b[32m✓ ready\x1b[0m');
}
process.exit(failed.length ? 1 : 0);
