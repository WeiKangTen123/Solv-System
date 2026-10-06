// The backup script had no test (it returned early under the in-memory test
// DB). It now takes the database and destination as arguments, verifies the
// copy with integrity_check, and prunes each kind by its own rule — all
// checkable on a temp file DB.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { run, _prune, KEEP_MIN, KEEP_PREDEPLOY } = require('./backup');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const db  = new Database(path.join(dir, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
  return { dir, db };
}

test('a backup is one portable file that passes integrity_check and holds the data', async () => {
  const { dir, db } = tempDb();
  const dest = await run({ db, destDir: path.join(dir, 'backups') });
  expect(fs.existsSync(dest)).toBe(true);
  expect(fs.existsSync(`${dest}-wal`)).toBe(false);
  const copy = new Database(dest, { readonly: true });
  expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(copy.prepare('SELECT v FROM t').get().v).toBe('hello');
});

const iso = msAgo => new Date(Date.now() - msAgo).toISOString().replace(/[:.]/g, '-');
const DAY = 86400000;
const names = dir => fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();

test('daily copies are kept for KEEP_DAYS, and never fewer than KEEP_MIN', async () => {
  const { dir, db } = tempDb();
  const destDir = path.join(dir, 'backups');
  fs.mkdirSync(destDir);
  const recent = [1, 2, 3, 4].map(d => `app-${iso(d * DAY)}.db`);
  const old = [20, 30, 40].map(d => `app-${iso(d * DAY)}.db`);
  for (const f of [...recent, ...old]) fs.writeFileSync(path.join(destDir, f), '');
  await run({ db, destDir });
  const kept = names(destDir);
  expect(kept).toHaveLength(5);                          // today's + the four recent ones
  for (const f of recent) expect(kept).toContain(f);
  for (const f of old) expect(kept).not.toContain(f);

  // A cron that stopped weeks ago still leaves the newest few.
  const { dir: dir2, db: db2 } = tempDb();
  const stale = path.join(dir2, 'backups');
  fs.mkdirSync(stale);
  for (const d of [30, 31, 32, 33, 34]) fs.writeFileSync(path.join(stale, `app-${iso(d * DAY)}.db`), '');
  _prune(stale);
  expect(names(stale)).toHaveLength(KEEP_MIN);
});

test('deploy copies are pruned on their own and never push a daily copy out', async () => {
  const { dir, db } = tempDb();
  const destDir = path.join(dir, 'backups');
  fs.mkdirSync(destDir);
  const daily = `app-${iso(DAY)}.db`;
  fs.writeFileSync(path.join(destDir, daily), '');
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(destDir, `predeploy-${iso((i + 1) * 60000)}.db`), '');
  await run({ db, destDir, kind: 'predeploy' });
  const kept = names(destDir);
  expect(kept).toContain(daily);
  expect(kept.filter(f => f.startsWith('predeploy-'))).toHaveLength(KEEP_PREDEPLOY);
});

test('"Backed up" is the last thing printed, after any pruning', async () => {
  const { dir, db } = tempDb();
  const destDir = path.join(dir, 'backups');
  fs.mkdirSync(destDir);
  for (let i = 0; i < KEEP_PREDEPLOY + 2; i++) fs.writeFileSync(path.join(destDir, `predeploy-${iso((i + 1) * 60000)}.db`), '');
  const lines = [];
  const spy = jest.spyOn(console, 'log').mockImplementation(l => lines.push(l));
  try { await run({ db, destDir, kind: 'predeploy' }); } finally { spy.mockRestore(); }
  expect(lines.some(l => /^Pruned/.test(l))).toBe(true);
  expect(lines[lines.length - 1]).toMatch(/^Backed up DB to .*predeploy-.*\.db$/);
});

test('no .tmp is left behind, and an old one from a killed run is cleared', async () => {
  const { dir, db } = tempDb();
  const destDir = path.join(dir, 'backups');
  fs.mkdirSync(destDir);
  const killed = path.join(destDir, `app-${iso(2 * 3600000)}.db.tmp`);
  fs.writeFileSync(killed, 'half a file');
  fs.utimesSync(killed, new Date(Date.now() - 2 * 3600000), new Date(Date.now() - 2 * 3600000));
  await run({ db, destDir });
  expect(fs.readdirSync(destDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
});

test('an unknown kind is refused', async () => {
  const { dir, db } = tempDb();
  await expect(run({ db, destDir: path.join(dir, 'b'), kind: 'weekly' })).rejects.toThrow(/Unknown backup kind/);
});

test('a copy that fails integrity_check is deleted and reported', async () => {
  const { dir } = tempDb();
  const destDir = path.join(dir, 'backups');
  const bad = { path: '/x/app.db', backup: async dest => fs.writeFileSync(dest, 'not a database') };
  await expect(run({ db: bad, destDir })).rejects.toThrow(/integrity/);
  expect(fs.readdirSync(destDir).filter(f => f.endsWith('.db'))).toHaveLength(0);
});
