const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const ZERO_KEY = '0'.repeat(64);

// The secrets are supplied here, not left to whatever main/.env the machine
// happens to have. Left to that, the "ready" cases passed on a developer's
// laptop and failed on CI, where there is no .env and preflight — rightly —
// refuses a box with no JWT_SECRET. A test that only passes with the author's
// dotfile is testing the dotfile.
const GOOD = { NODE_ENV: 'development', JWT_SECRET: 'j'.repeat(48), ENCRYPTION_KEY: 'a'.repeat(64) };

function preflight(env = {}, args = ['--json']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solv-pre-'));
  const opts = {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, ...GOOD, DATA_DIR: path.join(dir, 'data'), LOGS_DIR: path.join(dir, 'logs'), ...env },
  };
  try {
    return { code: 0, out: execFileSync(process.execPath, ['main/scripts/preflight.js', ...args], opts), dir };
  } catch (err) {
    return { code: err.status, out: err.stdout || '', dir };
  }
}
const state = (out, name) => JSON.parse(out).results.find(r => r.name === name);

describe('preflight', () => {
  // It says it reads and does not write. Asking migrate.js for the schema
  // version opened the database as a side effect, leaving an empty app.db
  // behind — under sudo, one owned by root that the app could then not write.
  test('creates nothing, least of all a database', () => {
    const { dir, code } = preflight();
    expect(code).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'data'))).toEqual([]);
  });

  // Quoted with JSON.stringify the path went inside double quotes, where the
  // shell ran anything in $(...) instead of measuring the disk.
  test('measures a directory whose name holds shell metacharacters', () => {
    const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'solv-pre-')) + '/a $(exit 7) `b` dir';
    fs.mkdirSync(odd, { recursive: true });
    const { out } = preflight({ DATA_DIR: odd });
    const disk = state(out, 'disk space');
    expect(disk.state).toBe('ok');
    expect(disk.detail).toMatch(/GB free/);
  });

  test('reports the schema a database is on without migrating it', () => {
    const { dir } = preflight();                      // makes the directories
    const dbPath = path.join(dir, 'data', 'app.db');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.pragma('user_version = 1');
    db.close();
    const before = fs.statSync(dbPath).mtimeMs;

    const { out, code } = preflight({ DATA_DIR: path.join(dir, 'data') });
    expect(code).toBe(0);
    expect(state(out, 'database').detail).toContain('boot will create the schema');
    expect(fs.statSync(dbPath).mtimeMs).toBe(before);  // read, not written
  });

  test('a real database reports its schema and what boot will do to it', () => {
    const { dir } = preflight();
    const dbPath = path.join(dir, 'data', 'app.db');
    // schema.sql straight into the file: db/index.js resolves to :memory: under
    // NODE_ENV=test, so running the migration here would leave the file empty.
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.exec(fs.readFileSync(path.join(ROOT, 'main/db/schema.sql'), 'utf8'));
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('c1', 'Solv', '2026-01-01')").run();
    db.prepare("INSERT INTO users (id, company_id, email, password, role, created_at) VALUES ('u1','c1','a@b.c','x','admin','2026-01-01')").run();
    db.pragma('user_version = 1');                            // as if an older release wrote it
    db.close();

    const { out, code } = preflight({ DATA_DIR: path.join(dir, 'data') });
    expect(code).toBe(0);
    const { LATEST } = require(path.join(ROOT, 'main/db/schema-version'));
    expect(state(out, 'database').detail).toContain(`boot will migrate 1 → ${LATEST}`);
    expect(state(out, 'database').detail).toMatch(/user\(s\)/);
  });

  test('a database newer than the code is a warning, not silence', () => {
    const { dir } = preflight();
    const dbPath = path.join(dir, 'data', 'app.db');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.pragma('user_version = 99');
    db.close();
    const { out } = preflight({ DATA_DIR: path.join(dir, 'data') });
    expect(state(out, 'database').state).toBe('warn');
    expect(state(out, 'database').detail).toContain('newer than this code expects');
  });

  test('refuses a production box carrying the example secrets', () => {
    const { code, out } = preflight({
      NODE_ENV: 'production',
      JWT_SECRET: 'change-me-to-a-long-random-string',
      ENCRYPTION_KEY: ZERO_KEY,
      XERO_OAUTH_REDIRECT_URI: 'http://not-https/api/xero/oauth/callback',
    });
    expect(code).toBe(1);
    expect(JSON.parse(out).ok).toBe(false);
    expect(state(out, 'JWT_SECRET').state).toBe('fail');
    expect(state(out, 'ENCRYPTION_KEY').state).toBe('fail');
    expect(state(out, 'Xero redirect URI').state).toBe('fail');
  });

  // The same values are only a warning in development, where they are the
  // documented defaults and refusing them would stop anyone working.
  test('tolerates them in development', () => {
    const { code, out } = preflight({ NODE_ENV: 'development', JWT_SECRET: 'x'.repeat(40), ENCRYPTION_KEY: ZERO_KEY });
    expect(code).toBe(0);
    expect(state(out, 'ENCRYPTION_KEY').state).toBe('warn');
  });
});
