# Solv Expense Claims — Phase 0 (foundation) and Phase 1 (intake and reading) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running Solv app where a signed-in employee uploads a receipt (photo, PDF, phone camera, or ZIP + claim form), the AI reads it — including scanned multi-page PDFs — into an expense with category lines, and reviews it on screen.

**Architecture:** A new repository at the workspace root with the Xero automation's layout (`main/` Express server, `ui/` Vite React app, tests beside every module). Proven modules are copied file by file from `/Users/weikangten/Desktop/xero-invoice-app-master` (HEAD `3f287f5`, 18 Sep 2026) with their tests, then Solv's own units are added: a company/roles user model, an expense store, a PDF page renderer (child process, pdfjs + napi canvas), a multi-page single-document read, and the expense review UI. Nothing here touches Xero or exchange rates; those are Phase 5 and Phase 2.

**Tech Stack:** Node 22+ (24 locally), Express 4, better-sqlite3 (WAL, cents as integers), jest 29 + supertest, React 18 + Vite 6, Gemini via the ported client, pdfjs-dist 6 + @napi-rs/canvas for rendering, sharp for thumbnails, pdf-parse for text layers, exceljs/yauzl for the batch import.

**Source for every port:** `XERO=/Users/weikangten/Desktop/xero-invoice-app-master`. Every `cp` below assumes that shell variable and the Solv root as the working directory.

---

## File structure

```
Solv System/
├── package.json  .gitignore  .nvmrc  eslint.config.js  ecosystem.config.js
├── main/
│   ├── index.js                    Express app, middleware, route mounts, boot recovery
│   ├── .env.example
│   ├── db/         index.js  schema.sql  migrate.js  backup.js
│   ├── middleware/ auth-middleware.js  async-handler.js  rate-limit-key.js  roles.js (new)
│   ├── utils/      logger paths ids base64 crypto llm-json gemini-client(adapted) receipt-parser(extended)
│   │               pdf-pages(extended) pdf-render(new) pdf-render-worker.mjs(new) receipt-store thumbnailer pairing users(rewritten)
│   ├── intake/     document.js  dedup.js
│   ├── claims/     categories(extended) claim-archive claim-form claim-matcher claim-import claim-queue claim-worker claim-record(rewritten)
│   ├── jobs/       index.js
│   ├── store/      expenses.js (new)      receipts + expenses + expense_lines CRUD
│   ├── receipts/   read-receipt.js (new)  classify → read → apply fields → build lines
│   ├── routes/     auth users(new) company(new) setup(trimmed) receipts(adapted) expenses(new) claims(adapted) dashboard
│   └── scripts/    jest.setup.js  test-server.js  ui-api-paths.test.js  lint.test.js
└── ui/
    ├── package.json  vite.config.js  index.html
    └── src/  main.jsx App.jsx api/client.js context/* styles/* components/* pages/*
```

Each file has one job; the two new server units that carry the design are `store/expenses.js` (every write to receipts/expenses/lines goes through it) and `receipts/read-receipt.js` (the only place that decides how a file is read).

---

## Phase 0 — Foundation

### Task 1: Scaffold the repository

**Files:**
- Create: `package.json`, `.gitignore`, `.nvmrc`, `eslint.config.js`, `main/.env.example`, `main/scripts/jest.setup.js`, `main/scripts/test-server.js`, `ui/package.json`, `ui/vite.config.js`, `ui/index.html`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "solv-expense-claims",
  "version": "0.1.0",
  "description": "Solv expense claims: receipts in any currency, read by AI, converted to SGD, approved, exported, posted to Xero",
  "main": "main/index.js",
  "scripts": {
    "start": "node main/index.js",
    "dev:server": "nodemon --delay 500ms --ext js,mjs --ignore 'main/data' --ignore 'logs' --ignore 'ui' main/index.js",
    "dev:ui": "npm --prefix ui run dev",
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:ui\"",
    "build:ui": "npm --prefix ui run build",
    "test": "jest --runInBand --forceExit",
    "lint": "eslint .",
    "backup": "node main/db/backup.js"
  },
  "dependencies": {
    "@napi-rs/canvas": "^1.0.9",
    "axios": "^1.20.0",
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^13.0.1",
    "compression": "^1.7.4",
    "dotenv": "^16.3.1",
    "exceljs": "^4.4.0",
    "express": "^4.18.2",
    "express-rate-limit": "^7.1.5",
    "helmet": "^7.1.0",
    "jsonwebtoken": "^9.0.3",
    "morgan": "^1.10.0",
    "pdf-parse": "^1.1.1",
    "pdfjs-dist": "^6.3.289",
    "pdfmake": "^0.2.23",
    "qrcode": "^1.5.4",
    "sharp": "^0.35.4",
    "winston": "^3.11.0",
    "xero-node": "^7.0.0",
    "yauzl": "^3.4.0"
  },
  "devDependencies": {
    "concurrently": "^8.2.2",
    "eslint": "^10.9.1",
    "eslint-plugin-react-hooks": "^7.1.1",
    "globals": "^17.12.0",
    "jest": "^29.7.0",
    "nodemon": "^3.0.2",
    "supertest": "^6.3.3"
  },
  "engines": { "node": ">=22.0.0", "npm": ">=9.0.0" },
  "jest": {
    "testTimeout": 20000,
    "testPathIgnorePatterns": ["/node_modules/", "/ui/"],
    "setupFiles": ["<rootDir>/main/scripts/jest.setup.js"]
  }
}
```

- [ ] **Step 2: Write .gitignore, .nvmrc**

`.gitignore`:
```
node_modules/
.env
*.log
logs/
coverage/
dist/
.DS_Store
main/data/
ui/node_modules/
ui/dist/
*.bak
.claude/settings.local.json
```
`.nvmrc`: `22`

- [ ] **Step 3: Copy eslint config and the test helpers**

```bash
cp "$XERO/eslint.config.js" eslint.config.js
sed -i '' "s#'report/\*\*', 'docs/archive/\*\*',#'docs/**',#" eslint.config.js
mkdir -p main/scripts
cp "$XERO/main/scripts/jest.setup.js" main/scripts/jest.setup.js
sed -i '' "s/xero-test-/solv-test-/" main/scripts/jest.setup.js
cp "$XERO/main/scripts/test-server.js" main/scripts/test-server.js
```

- [ ] **Step 4: Write main/.env.example**

```
# Required
JWT_SECRET=change-me-to-a-long-random-string
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
NODE_ENV=development
PORT=4000

# Optional
# Gemini_API_KEY=            fallback reader key when the company has added none in Settings
# ALLOW_REGISTRATION=true    reopen self-registration after the first (admin) account
# DATA_DIR=                  where receipts, queues and the database live (default main/data)
# LOGS_DIR=                  default ./logs
# SLACK_WEBHOOK_URL=
```

- [ ] **Step 5: Write ui/package.json, ui/vite.config.js, ui/index.html**

`ui/package.json`:
```json
{
  "name": "solv-expense-ui",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1", "react-router-dom": "^6.28.0" },
  "devDependencies": { "@vitejs/plugin-react": "^4.3.4", "vite": "^6.0.5" }
}
```
`ui/vite.config.js`:
```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
```
`ui/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Solv Expenses</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Install and prove the test runner starts**

Run: `npm install && npm --prefix ui install && npx jest --version`
Expected: installs without errors; jest prints `29.x`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold Solv server and UI packages"
```

### Task 2: Port the small utilities with their tests

**Files:**
- Create (copied): `main/utils/{logger,paths,ids,base64,crypto,llm-json}.js` and their `.test.js`

- [ ] **Step 1: Copy**

```bash
mkdir -p main/utils
for f in logger paths ids base64 crypto llm-json; do cp "$XERO/main/utils/$f.js" main/utils/; done
for f in paths ids base64 crypto llm-json; do cp "$XERO/main/utils/$f.test.js" main/utils/; done
```

- [ ] **Step 2: Run the ported tests**

Run: `npx jest main/utils`
Expected: PASS, every file green.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "port(utils): logger, paths, ids, base64, crypto, llm-json with tests"
```

### Task 3: Database schema, connection, migrations, backup

**Files:**
- Create: `main/db/schema.sql`, `main/db/index.js`, `main/db/migrate.js`, `main/db/migrate.test.js`
- Create (copied): `main/db/backup.js`, `main/db/backup.test.js`

- [ ] **Step 1: Write the failing migration test**

`main/db/migrate.test.js`:
```js
describe('db/migrate', () => {
  let db;
  beforeEach(() => { jest.resetModules(); db = require('./index'); require('./migrate').run(); });

  test('creates every Solv table', () => {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const t of ['companies', 'users', 'company_credentials', 'company_gemini_keys', 'xero_tenants',
                     'receipts', 'expenses', 'expense_lines', 'expense_reports', 'fx_rates', 'report_events']) {
      expect(names).toContain(t);
    }
  });

  test('is idempotent', () => {
    expect(() => require('./migrate').run()).not.toThrow();
  });

  test('money columns are integers and expenses reject an unknown status', () => {
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('c1', 'Solv', '2026-01-01')").run();
    db.prepare("INSERT INTO users (id, company_id, email, password, role, created_at) VALUES ('u1','c1','a@b.c','x','employee','2026-01-01')").run();
    expect(() => db.prepare("INSERT INTO expenses (id, company_id, user_id, status, created_at) VALUES ('e1','c1','u1','bogus','2026-01-01')").run()).toThrow();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest main/db/migrate.test.js`
Expected: FAIL — cannot find module './index'.

- [ ] **Step 3: Write db/index.js**

```js
const path     = require('path');
const Database = require('better-sqlite3');

// Tests get an isolated in-memory DB per process; production and dev use a
// file under DATA_DIR so data survives restarts.
const DB_PATH = process.env.NODE_ENV === 'test'
  ? ':memory:'
  : (process.env.DB_PATH || path.join(require('../utils/paths').DATA_DIR, 'app.db'));

if (DB_PATH !== ':memory:') require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
module.exports.path = DB_PATH;
```

- [ ] **Step 4: Write db/schema.sql**

```sql
-- Solv Expense Claims — SQLite schema. Money is INTEGER cents; timestamps are UTC ISO strings.

CREATE TABLE IF NOT EXISTS companies (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  base_currency  TEXT NOT NULL DEFAULT 'SGD',
  fx_policy      TEXT NOT NULL DEFAULT 'receipt_date' CHECK (fx_policy IN ('receipt_date', 'submission_date', 'monthly_fixed')),
  timezone       TEXT NOT NULL DEFAULT 'Asia/Singapore',
  report_columns TEXT NOT NULL DEFAULT '[]',   -- JSON array of category names, in report column order
  logo           TEXT,
  next_report_no INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email        TEXT NOT NULL UNIQUE,
  password     TEXT NOT NULL,
  name         TEXT,
  employee_id  TEXT,
  department   TEXT,
  role         TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'manager', 'finance', 'admin')),
  manager_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);

-- Company-level connections. Secrets are AES-256-GCM encrypted (utils/crypto.js).
CREATE TABLE IF NOT EXISTS company_credentials (
  company_id               TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  xero_client_id           TEXT,
  xero_client_secret       TEXT,
  xero_oauth_client_id     TEXT,
  xero_oauth_client_secret TEXT,
  xero_oauth_refresh_token TEXT,
  xero_oauth_connected_at  TEXT,
  xero_connection_type     TEXT,
  default_account_code     TEXT
);

CREATE TABLE IF NOT EXISTS company_gemini_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  api_key    TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS xero_tenants (
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL,
  tenant_name  TEXT,
  connected_at TEXT NOT NULL,
  PRIMARY KEY (company_id, tenant_id)
);

-- One stored file. Several expenses may point at one receipt (a photo of several
-- receipts, or a batch import that reuses a byte-identical file).
CREATE TABLE IF NOT EXISTS receipts (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  sha256        TEXT,
  pages         INTEGER,
  source        TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'phone', 'import')),
  group_id      TEXT,
  original_name TEXT,
  received_at   TEXT NOT NULL,
  parsed_at     TEXT,
  parse_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_user ON receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_receipts_hash ON receipts(company_id, sha256);

CREATE TABLE IF NOT EXISTS expense_reports (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number          TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'trip' CHECK (kind IN ('trip', 'period')),
  title           TEXT,
  purpose         TEXT,
  period_from     TEXT,
  period_to       TEXT,
  destination     TEXT,
  nights          INTEGER,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'paid', 'posted')),
  submitted_at    TEXT,
  approved_by     TEXT,
  approved_at     TEXT,
  rejected_reason TEXT,
  advances_cents  INTEGER NOT NULL DEFAULT 0,
  paid_at         TEXT,
  xero_invoice_id TEXT,
  xero_error      TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_user ON expense_reports(user_id, status);

CREATE TABLE IF NOT EXISTS expenses (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receipt_id     TEXT REFERENCES receipts(id) ON DELETE SET NULL,
  report_id      TEXT REFERENCES expense_reports(id) ON DELETE SET NULL,
  merchant       TEXT,
  receipt_date   TEXT,
  receipt_time   TEXT,
  invoice_no     TEXT,
  currency       TEXT,
  total_cents    INTEGER NOT NULL DEFAULT 0,
  tax_cents      INTEGER,
  subtotal_cents INTEGER,
  purpose        TEXT,
  description    TEXT,
  category       TEXT,
  status         TEXT NOT NULL CHECK (status IN ('reading', 'review-needed', 'reviewed', 'duplicate', 'rejected')),
  duplicate_of   TEXT REFERENCES expenses(id) ON DELETE SET NULL,
  error_msg      TEXT,
  ai_read_at     TEXT,
  ai_confidence  TEXT,
  box            TEXT,      -- JSON [ymin,xmin,ymax,xmax] 0-1000 when one photo held several receipts
  page           INTEGER,   -- 1-based page when one PDF page is its own receipt
  source         TEXT NOT NULL DEFAULT 'upload',
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_user   ON expenses(user_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_report ON expenses(report_id);
CREATE INDEX IF NOT EXISTS idx_expenses_receipt ON expenses(receipt_id);

CREATE TABLE IF NOT EXISTS expense_lines (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id         TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  category           TEXT,
  description        TEXT,
  amount_cents       INTEGER NOT NULL DEFAULT 0,
  currency           TEXT,
  fx_rate            REAL,
  fx_rate_date       TEXT,
  fx_source          TEXT,
  fx_fetched_at      TEXT,
  fx_policy          TEXT,
  fx_override_by     TEXT,
  fx_override_reason TEXT,
  base_cents         INTEGER,
  on_behalf_of       TEXT,
  account_code       TEXT
);
CREATE INDEX IF NOT EXISTS idx_lines_expense ON expense_lines(expense_id);

CREATE TABLE IF NOT EXISTS fx_rates (
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  rate_date  TEXT NOT NULL,
  rate       REAL NOT NULL,
  source     TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (base, quote, rate_date, source)
);

CREATE TABLE IF NOT EXISTS report_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL REFERENCES expense_reports(id) ON DELETE CASCADE,
  actor_id  TEXT,
  action    TEXT NOT NULL,
  note      TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_report ON report_events(report_id);
```

- [ ] **Step 5: Write db/migrate.js**

```js
const fs   = require('fs');
const path = require('path');
const db   = require('./index');

// SQLite has no ADD COLUMN IF NOT EXISTS, so columns added after a deploy are
// ensured here explicitly. Steps numbered through PRAGMA user_version run once.
function _ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function _step(n, name, fn) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= n) return;
  try { fn(); db.pragma(`user_version = ${n}`); }
  catch (err) { require('../utils/logger').warn(`migration step ${n} (${name}) skipped`, { error: err.message }); }
}

function run() {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // Later phases add their columns here, e.g. _ensureColumn('expense_lines', 'x', 'x TEXT');
}

module.exports = { run, _ensureColumn, _step };
```

- [ ] **Step 6: Copy backup.js and its test; run all db tests**

```bash
cp "$XERO/main/db/backup.js" main/db/backup.js
cp "$XERO/main/db/backup.test.js" main/db/backup.test.js
```
Run: `npx jest main/db`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(db): Solv schema, connection, migration runner, verified backup"
```

### Task 4: Users, companies, roles, and auth

**Files:**
- Create: `main/utils/users.js`, `main/utils/users.test.js`, `main/middleware/roles.js`, `main/middleware/roles.test.js`, `main/routes/auth.js`, `main/routes/auth.test.js`, `main/routes/users.js`, `main/routes/users.test.js`, `main/routes/company.js`, `main/routes/company.test.js`
- Create (copied): `main/middleware/auth-middleware.js`, `main/middleware/async-handler.js`, `main/middleware/rate-limit-key.js`

- [ ] **Step 1: Copy middleware**

```bash
mkdir -p main/middleware main/routes
for f in auth-middleware async-handler rate-limit-key; do cp "$XERO/main/middleware/$f.js" main/middleware/; done
```

- [ ] **Step 2: Write the failing users test**

`main/utils/users.test.js`:
```js
describe('utils/users', () => {
  let users, db;
  beforeEach(() => { jest.resetModules(); db = require('../db'); require('../db/migrate').run(); users = require('./users'); });

  test('the first account creates the company and becomes admin', async () => {
    const u = await users.createUser({ email: 'wk@solv.sg', password: 'password123', name: 'Wei Kang' });
    expect(u.role).toBe('admin');
    expect(u.companyId).toBeTruthy();
    const company = users.getCompany(u.companyId);
    expect(company.name).toBe('Solv');
    expect(company.baseCurrency).toBe('SGD');
    expect(company.fxPolicy).toBe('receipt_date');
    expect(Array.isArray(company.reportColumns)).toBe(true);
    expect(company.reportColumns.length).toBeGreaterThan(3);
  });

  test('later accounts join the same company as employees unless a role is given', async () => {
    const admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    const e = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    const m = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: admin.companyId, role: 'manager' });
    expect(e.role).toBe('employee');
    expect(m.role).toBe('manager');
    expect(e.companyId).toBe(admin.companyId);
  });

  test('a manager can be assigned and read back; sanitize never leaks the hash', async () => {
    const admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    const m = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: admin.companyId, role: 'manager' });
    const e = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    users.updateUser(e.id, { managerId: m.id, department: 'Sales', employeeId: 'S0042', name: 'Elaine' });
    const back = users.findById(e.id);
    expect(back.managerId).toBe(m.id);
    expect(back.department).toBe('Sales');
    expect(back.employeeId).toBe('S0042');
    expect(back.password).toBeUndefined();
    expect(users.reportsTo(e.id, m.id)).toBe(true);
    expect(users.reportsTo(m.id, e.id)).toBe(false);
  });

  test('validatePassword and email uniqueness', async () => {
    await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    expect(await users.validatePassword('A@solv.sg', 'password123')).toMatchObject({ email: 'a@solv.sg' });
    expect(await users.validatePassword('a@solv.sg', 'wrong')).toBeNull();
    await expect(users.createUser({ email: 'a@solv.sg', password: 'password123' })).rejects.toThrow(/exists/);
  });

  test('company settings round-trip and gemini keys are encrypted at rest', async () => {
    const admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    users.updateCompany(admin.companyId, { name: 'Solv Pte Ltd', reportColumns: ['Lodging', 'Meals'], fxPolicy: 'submission_date' });
    const c = users.getCompany(admin.companyId);
    expect(c.name).toBe('Solv Pte Ltd');
    expect(c.reportColumns).toEqual(['Lodging', 'Meals']);
    expect(c.fxPolicy).toBe('submission_date');
    users.addGeminiKey(admin.companyId, 'AIza-secret-key-1234', 'main');
    const raw = db.prepare('SELECT api_key FROM company_gemini_keys').get().api_key;
    expect(raw).not.toContain('AIza');
    expect(users.getGeminiKeys(admin.companyId)[0].apiKey).toBe('AIza-secret-key-1234');
    expect(users.getGeminiKeysForUser(admin.id)).toHaveLength(1);
  });

  test('deleteUser removes the row', async () => {
    const admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    const e = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    users.deleteUser(e.id);
    expect(users.findById(e.id)).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx jest main/utils/users.test.js`
Expected: FAIL — cannot find module './users'.

- [ ] **Step 4: Write utils/users.js**

```js
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('../db');
const { encrypt, decrypt } = require('./crypto');

const DEFAULT_TIMEZONE = 'Asia/Singapore';
const DEFAULT_COMPANY  = { name: 'Solv', baseCurrency: 'SGD', fxPolicy: 'receipt_date', timezone: DEFAULT_TIMEZONE };
// The report's column set, in column order. Matches claims/categories.js names
// so a category on a line is also a column on paper.
const DEFAULT_REPORT_COLUMNS = ['Air & Transport', 'Lodging', 'Meals', 'Entertainment', 'Phone', 'Fuel/Mileage', 'Other'];
const ROLES = ['employee', 'manager', 'finance', 'admin'];
const ONLINE_THRESHOLD_MS = 3 * 60 * 1000;

function isOnline(lastSeenAt) { return !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS; }

function sanitize(u) {
  if (!u) return null;
  return {
    id: u.id, companyId: u.company_id, email: u.email, role: u.role, name: u.name || null,
    employeeId: u.employee_id || null, department: u.department || null, managerId: u.manager_id || null,
    createdAt: u.created_at, lastSeenAt: u.last_seen_at || null, online: isOnline(u.last_seen_at),
  };
}

// ── Companies ────────────────────────────────────────────────────────────────
function _companyRow(row) {
  if (!row) return null;
  let cols = [];
  try { cols = JSON.parse(row.report_columns || '[]'); } catch { cols = []; }
  return {
    id: row.id, name: row.name, baseCurrency: row.base_currency, fxPolicy: row.fx_policy, timezone: row.timezone,
    reportColumns: cols, logo: row.logo || null, nextReportNo: row.next_report_no, createdAt: row.created_at,
  };
}

function getCompany(id) { return _companyRow(db.prepare('SELECT * FROM companies WHERE id = ?').get(id)); }

function createCompany(patch = {}) {
  const id = `c${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  db.prepare(`INSERT INTO companies (id, name, base_currency, fx_policy, timezone, report_columns, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, patch.name || DEFAULT_COMPANY.name, patch.baseCurrency || DEFAULT_COMPANY.baseCurrency,
         patch.fxPolicy || DEFAULT_COMPANY.fxPolicy, patch.timezone || DEFAULT_COMPANY.timezone,
         JSON.stringify(patch.reportColumns || DEFAULT_REPORT_COLUMNS), new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO company_credentials (company_id) VALUES (?)').run(id);
  return getCompany(id);
}

const COMPANY_COLUMNS = { name: 'name', baseCurrency: 'base_currency', fxPolicy: 'fx_policy', timezone: 'timezone', logo: 'logo' };
function updateCompany(id, patch) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries(COMPANY_COLUMNS)) {
    if (patch[k] === undefined) continue;
    sets.push(`${col} = ?`); args.push(patch[k]);
  }
  if (Array.isArray(patch.reportColumns)) {
    sets.push('report_columns = ?');
    args.push(JSON.stringify(patch.reportColumns.map(c => String(c).trim()).filter(Boolean)));
  }
  if (sets.length) db.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return getCompany(id);
}

// Company credentials (Xero). Secrets encrypted; a blank patch value clears.
const CRED_COLUMNS = {
  XERO_CLIENT_ID: 'xero_client_id', XERO_CLIENT_SECRET: 'xero_client_secret',
  XERO_OAUTH_CLIENT_ID: 'xero_oauth_client_id', XERO_OAUTH_CLIENT_SECRET: 'xero_oauth_client_secret',
  XERO_OAUTH_REFRESH_TOKEN: 'xero_oauth_refresh_token', XERO_OAUTH_CONNECTED_AT: 'xero_oauth_connected_at',
  XERO_CONNECTION_TYPE: 'xero_connection_type', DEFAULT_ACCOUNT_CODE: 'default_account_code',
};
const CRED_TO_KEY = Object.fromEntries(Object.entries(CRED_COLUMNS).map(([k, v]) => [v, k]));
const ENCRYPTED_COLUMNS = new Set(['xero_client_secret', 'xero_oauth_client_secret', 'xero_oauth_refresh_token']);

function getCompanyConfig(companyId) {
  const row = db.prepare('SELECT * FROM company_credentials WHERE company_id = ?').get(companyId);
  if (!row) return {};
  const out = {};
  for (const [col, value] of Object.entries(row)) {
    if (col === 'company_id' || value === null) continue;
    out[CRED_TO_KEY[col]] = ENCRYPTED_COLUMNS.has(col) ? decrypt(value) : value;
  }
  return out;
}

function saveCompanyConfig(companyId, patch) {
  db.prepare('INSERT OR IGNORE INTO company_credentials (company_id) VALUES (?)').run(companyId);
  const sets = [], args = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = CRED_COLUMNS[key];
    if (!col || value === undefined || value === null) continue;
    sets.push(`${col} = ?`);
    args.push(value === '' ? null : (ENCRYPTED_COLUMNS.has(col) ? encrypt(value) : value));
  }
  if (sets.length) db.prepare(`UPDATE company_credentials SET ${sets.join(', ')} WHERE company_id = ?`).run(...args, companyId);
  return getCompanyConfig(companyId);
}

// ── Users ────────────────────────────────────────────────────────────────────
function hasUsers() { return db.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined; }
function findById(id) { return sanitize(db.prepare('SELECT * FROM users WHERE id = ?').get(id)); }
function _rawByEmail(email) { return db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email) || null; }
function findByEmail(email) { return sanitize(_rawByEmail(email)); }

const _lastTouchWrite = new Map();
const TOUCH_THROTTLE_MS = 60 * 1000;
function touchLastSeen(userId) {
  const now = Date.now();
  if (now - (_lastTouchWrite.get(userId) || 0) < TOUCH_THROTTLE_MS) return;
  _lastTouchWrite.set(userId, now);
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(new Date(now).toISOString(), userId);
}

// The first account ever creates the company and is its admin. Every later
// account must name a company (the admin's, in practice) and defaults to
// employee unless a role is given.
async function createUser({ email, password, name = null, role = null, companyId = null, employeeId = null, department = null, managerId = null }) {
  if (!email || !password) throw new Error('Email and password are required');
  if (role && !ROLES.includes(role)) throw new Error(`Unknown role "${role}"`);
  const hash = await bcrypt.hash(password, 10);
  const create = db.transaction(() => {
    if (_rawByEmail(email)) throw new Error('Email already exists');
    const first = !hasUsers();
    const company = companyId ? getCompany(companyId) : (first ? createCompany() : null);
    if (!company) throw new Error('A company is required');
    const user = {
      id: `${Date.now()}${crypto.randomBytes(4).toString('hex')}`,
      companyId: company.id, email: email.toLowerCase().trim(), password: hash,
      role: role || (first ? 'admin' : 'employee'), name, employeeId, department, managerId,
      createdAt: new Date().toISOString(),
    };
    db.prepare(`INSERT INTO users (id, company_id, email, password, name, employee_id, department, role, manager_id, created_at)
                VALUES (@id, @companyId, @email, @password, @name, @employeeId, @department, @role, @managerId, @createdAt)`).run(user);
    return findById(user.id);
  });
  return create();
}

async function validatePassword(email, password) {
  const raw = _rawByEmail(email);
  if (!raw) return null;
  return (await bcrypt.compare(password, raw.password)) ? sanitize(raw) : null;
}

const USER_COLUMNS = { name: 'name', employeeId: 'employee_id', department: 'department', managerId: 'manager_id', role: 'role' };
function updateUser(id, patch) {
  if (patch.role !== undefined && !ROLES.includes(patch.role)) throw new Error(`Unknown role "${patch.role}"`);
  if (patch.managerId !== undefined && patch.managerId !== null) {
    if (patch.managerId === id) throw new Error('A user cannot manage themselves');
    if (!findById(patch.managerId)) throw new Error('Manager not found');
  }
  const sets = [], args = [];
  for (const [k, col] of Object.entries(USER_COLUMNS)) {
    if (patch[k] === undefined) continue;
    sets.push(`${col} = ?`); args.push(patch[k] === '' ? null : patch[k]);
  }
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return findById(id);
}

async function setPassword(id, password) {
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(await bcrypt.hash(password, 10), id);
}

function getAllUsers(companyId) {
  return db.prepare('SELECT * FROM users WHERE company_id = ? ORDER BY created_at').all(companyId).map(sanitize);
}
function deleteUser(id) { db.prepare('DELETE FROM users WHERE id = ?').run(id); }
function readUsers() { return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(sanitize); }

// Does `userId` report to `managerId`, directly? One level, by decision.
function reportsTo(userId, managerId) {
  const u = findById(userId);
  return !!u && !!managerId && u.managerId === managerId;
}

// ── Reader keys (company-wide) ──────────────────────────────────────────────
function getGeminiKeys(companyId) {
  return db.prepare('SELECT id, api_key, label, created_at FROM company_gemini_keys WHERE company_id = ? ORDER BY id').all(companyId)
    .map(r => ({ id: r.id, apiKey: decrypt(r.api_key), label: r.label, createdAt: r.created_at }));
}
function getGeminiKeysForUser(userId) {
  const u = findById(userId);
  return u ? getGeminiKeys(u.companyId) : [];
}
function addGeminiKey(companyId, apiKey, label) {
  if (!apiKey || !apiKey.trim()) throw new Error('API key is required');
  const info = db.prepare('INSERT INTO company_gemini_keys (company_id, api_key, label, created_at) VALUES (?, ?, ?, ?)')
    .run(companyId, encrypt(apiKey.trim()), label ? label.trim().slice(0, 60) : null, new Date().toISOString());
  return { id: info.lastInsertRowid };
}
function removeGeminiKey(companyId, keyId) {
  return db.prepare('DELETE FROM company_gemini_keys WHERE id = ? AND company_id = ?').run(keyId, companyId).changes > 0;
}

// Per-user defaults the intake modules ask for (currency, timezone).
function getUserDefaults(userId) {
  const u = userId ? findById(userId) : null;
  const c = u ? getCompany(u.companyId) : null;
  return { currency: (c && c.baseCurrency) || 'SGD', timezone: (c && c.timezone) || DEFAULT_TIMEZONE, accountCode: { claim: null } };
}

function ensureUserDirectories() { /* nothing per user to provision yet; kept for index.js symmetry */ }

module.exports = {
  ROLES, DEFAULT_TIMEZONE, DEFAULT_REPORT_COLUMNS,
  hasUsers, findById, findByEmail, createUser, validatePassword, updateUser, setPassword, getAllUsers, deleteUser, readUsers,
  reportsTo, touchLastSeen, isOnline, sanitize,
  getCompany, createCompany, updateCompany, getCompanyConfig, saveCompanyConfig, ENCRYPTED_COLUMNS,
  getGeminiKeys, getGeminiKeysForUser, addGeminiKey, removeGeminiKey, getUserDefaults, ensureUserDirectories,
};
```

- [ ] **Step 5: Run the users test**

Run: `npx jest main/utils/users.test.js`
Expected: PASS.

- [ ] **Step 6: Write the failing roles middleware test**

`main/middleware/roles.test.js`:
```js
const { requireRole, canAccessUser } = require('./roles');

describe('middleware/roles', () => {
  const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };

  test('requireRole passes a listed role and refuses others with 403', () => {
    const next = jest.fn(); const r = res();
    requireRole('finance', 'admin')({ user: { role: 'finance' } }, r, next);
    expect(next).toHaveBeenCalled();
    const r2 = res(); const next2 = jest.fn();
    requireRole('finance', 'admin')({ user: { role: 'employee' } }, r2, next2);
    expect(r2.status).toHaveBeenCalledWith(403);
    expect(next2).not.toHaveBeenCalled();
  });

  test('canAccessUser: self, finance/admin over anyone, manager over a direct report only', () => {
    const users = { reportsTo: (u, m) => u === 'e1' && m === 'm1' };
    expect(canAccessUser({ id: 'e1', role: 'employee' }, 'e1', users)).toBe(true);
    expect(canAccessUser({ id: 'e2', role: 'employee' }, 'e1', users)).toBe(false);
    expect(canAccessUser({ id: 'f1', role: 'finance' }, 'e1', users)).toBe(true);
    expect(canAccessUser({ id: 'a1', role: 'admin' }, 'e1', users)).toBe(true);
    expect(canAccessUser({ id: 'm1', role: 'manager' }, 'e1', users)).toBe(true);
    expect(canAccessUser({ id: 'm2', role: 'manager' }, 'e1', users)).toBe(false);
  });
});
```

- [ ] **Step 7: Write middleware/roles.js**

```js
// Who may see or act on whose data. Employees see their own; a manager sees
// their direct reports; finance and admin see the company. One place, so every
// route answers the same way.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this' });
    next();
  };
}

function canAccessUser(actor, ownerId, users = require('../utils/users')) {
  if (!actor || !ownerId) return false;
  if (actor.id === ownerId) return true;
  if (actor.role === 'finance' || actor.role === 'admin') return true;
  if (actor.role === 'manager') return users.reportsTo(ownerId, actor.id);
  return false;
}

module.exports = { requireRole, canAccessUser };
```

Run: `npx jest main/middleware`
Expected: PASS.

- [ ] **Step 8: Write the auth route and its test**

`main/routes/auth.js`:
```js
const express   = require('express');
const router    = express.Router();
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const users     = require('../utils/users');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
const logger    = require('../utils/logger');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: process.env.NODE_ENV === 'test' ? 1000 : 10,
  keyGenerator: req => req.ip, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts from this address. Try again in 15 minutes.' },
});

function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret(), { expiresIn: '7d' });
}

router.get('/status', (_req, res) => res.json({ hasUsers: users.hasUsers() }));

// The first account creates the company and is its admin. After that,
// registration is closed unless ALLOW_REGISTRATION=true; admins add staff.
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (users.hasUsers() && process.env.ALLOW_REGISTRATION !== 'true') {
      return res.status(403).json({ error: 'Registration is closed. Ask your administrator to add you.' });
    }
    // A later self-registration (flag on) joins the first company as an employee.
    const first = !users.hasUsers();
    const companyId = first ? null : users.readUsers()[0].companyId;
    const user = await users.createUser({ email, password, name: name || null, companyId });
    logger.info('User registered', { email: user.email, role: user.role });
    res.status(201).json({ success: true, user, token: sign(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await users.validatePassword(email, password);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    logger.info('User logged in', { email: user.email, role: user.role });
    res.json({ token: sign(user), user });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', requireAuth, (_req, res) => res.json({ ok: true }));

router.get('/me', requireAuth, (req, res) => {
  const user = users.findById(req.user.id);
  const company = users.getCompany(user.companyId);
  res.json({ user: { ...user, timezone: company.timezone, baseCurrency: company.baseCurrency, companyName: company.name } });
});

module.exports = router;
```

`main/routes/auth.test.js`:
```js
const request = require('supertest');
const express = require('express');
const { serverFor } = require('../scripts/test-server');

describe('routes/auth', () => {
  let app;
  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
  });

  test('first registration is admin, returns a token, and /me carries the company', async () => {
    const reg = await request(serverFor(app)).post('/api/auth/register').send({ email: 'wk@solv.sg', password: 'password123', name: 'Wei Kang' }).expect(201);
    expect(reg.body.user.role).toBe('admin');
    const me = await request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${reg.body.token}`).expect(200);
    expect(me.body.user.baseCurrency).toBe('SGD');
    expect(me.body.user.companyName).toBe('Solv');
  });

  test('second registration is refused unless ALLOW_REGISTRATION=true', async () => {
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'a@solv.sg', password: 'password123' }).expect(201);
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'b@solv.sg', password: 'password123' }).expect(403);
    process.env.ALLOW_REGISTRATION = 'true';
    const r = await request(serverFor(app)).post('/api/auth/register').send({ email: 'b@solv.sg', password: 'password123' }).expect(201);
    delete process.env.ALLOW_REGISTRATION;
    expect(r.body.user.role).toBe('employee');
  });

  test('login works with the right password and fails with the wrong one', async () => {
    await request(serverFor(app)).post('/api/auth/register').send({ email: 'a@solv.sg', password: 'password123' }).expect(201);
    await request(serverFor(app)).post('/api/auth/login').send({ email: 'a@solv.sg', password: 'password123' }).expect(200);
    await request(serverFor(app)).post('/api/auth/login').send({ email: 'a@solv.sg', password: 'nope' }).expect(401);
  });
});
```

Run: `npx jest main/routes/auth.test.js`
Expected: PASS.

- [ ] **Step 9: Write users and company routes with tests**

`main/routes/users.js`:
```js
const express = require('express');
const router  = express.Router();
const users   = require('../utils/users');
const { requireAuth } = require('../middleware/auth-middleware');
const { requireRole } = require('../middleware/roles');
const logger  = require('../utils/logger');

// Staff directory. Everyone signed in may list names (to pick a colleague for
// "paid on behalf of"); only admins create, change roles or delete.
router.get('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  const list = users.getAllUsers(me.companyId);
  const full = req.user.role === 'admin' || req.user.role === 'finance';
  res.json({ users: full ? list : list.map(u => ({ id: u.id, name: u.name, email: u.email, department: u.department, role: u.role })) });
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const { email, password, name, role, employeeId, department, managerId } = req.body || {};
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const user = await users.createUser({ email, password, name, role: role || 'employee', companyId: me.companyId, employeeId, department, managerId });
    logger.info('User created', { by: req.user.email, email: user.email, role: user.role });
    res.status(201).json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id', requireAuth, (req, res) => {
  try {
    const target = users.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const me = users.findById(req.user.id);
    if (target.companyId !== me.companyId) return res.status(404).json({ error: 'User not found' });
    const isAdmin = req.user.role === 'admin';
    const self = target.id === req.user.id;
    if (!isAdmin && !self) return res.status(403).json({ error: 'You can only edit your own profile' });
    const body = req.body || {};
    const patch = { name: body.name, employeeId: body.employeeId, department: body.department };
    if (isAdmin) { patch.role = body.role; patch.managerId = body.managerId; }
    const user = users.updateUser(target.id, patch);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/password', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.params.id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
    await users.setPassword(req.params.id, (req.body || {}).password);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const target = users.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  users.deleteUser(target.id);
  logger.info('User deleted', { by: req.user.email, email: target.email });
  res.json({ ok: true });
});

module.exports = router;
```

`main/routes/company.js`:
```js
const express = require('express');
const router  = express.Router();
const users   = require('../utils/users');
const { requireAuth } = require('../middleware/auth-middleware');
const { requireRole } = require('../middleware/roles');
const { CATEGORY_NAMES } = require('../claims/categories');

// Company settings: name, base currency, exchange-rate policy, the report's
// column set, reader keys. Readable by everyone (the UI needs the columns);
// writable by admin and finance.
router.get('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  res.json({ company: users.getCompany(me.companyId), categories: CATEGORY_NAMES });
});

router.patch('/', requireAuth, requireRole('admin', 'finance'), (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const b = req.body || {};
    if (b.fxPolicy && !['receipt_date', 'submission_date', 'monthly_fixed'].includes(b.fxPolicy)) return res.status(400).json({ error: 'Unknown exchange-rate policy' });
    if (b.baseCurrency && !/^[A-Z]{3}$/.test(b.baseCurrency)) return res.status(400).json({ error: 'Base currency must be a 3-letter code' });
    const company = users.updateCompany(me.companyId, b);
    res.json({ company });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/llm-keys', requireAuth, requireRole('admin', 'finance'), (req, res) => {
  const me = users.findById(req.user.id);
  res.json({ keys: users.getGeminiKeys(me.companyId).map(k => ({
    id: k.id, label: k.label, createdAt: k.createdAt,
    keyMasked: k.apiKey.length > 8 ? `${k.apiKey.slice(0, 4)}••••${k.apiKey.slice(-4)}` : '••••',
  })) });
});

router.post('/llm-keys', requireAuth, requireRole('admin', 'finance'), (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const { apiKey, label } = req.body || {};
    res.status(201).json({ success: true, id: users.addGeminiKey(me.companyId, apiKey, label).id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/llm-keys/:id', requireAuth, requireRole('admin', 'finance'), (req, res) => {
  const me = users.findById(req.user.id);
  if (!users.removeGeminiKey(me.companyId, Number(req.params.id))) return res.status(404).json({ error: 'Key not found' });
  res.json({ success: true });
});

module.exports = router;
```

The company router requires `claims/categories.js`, so create it now (it is a port plus the on-paper column names):

```bash
mkdir -p main/claims
cp "$XERO/main/claims/categories.js" main/claims/categories.js
cp "$XERO/main/claims/claim-categories.test.js" main/claims/claim-categories.test.js
```
Then replace the CATEGORIES list in `main/claims/categories.js` with:
```js
const CATEGORIES = [
  { name: 'Air & Transport',    scope: 'flights, trains, taxis, ride-hailing, public transport, parking, tolls' },
  { name: 'Lodging',            scope: 'hotel rooms and accommodation, including room taxes and service charges' },
  { name: 'Meals',              scope: 'breakfast, lunch, dinner, room service, cafe and food delivery, including their taxes' },
  { name: 'Entertainment',      scope: 'client entertainment, events, hospitality' },
  { name: 'Phone',              scope: 'mobile, roaming, SIM cards, internet and telecom bills' },
  { name: 'Fuel/Mileage',       scope: 'petrol, diesel, EV charging, mileage claims' },
  { name: 'Office Supplies',    scope: 'stationery, printer toner, desk accessories, minor equipment' },
  { name: 'Software/Utilities', scope: 'cloud servers, software subscriptions, utilities' },
  { name: 'Medical/Dental',     scope: 'clinic visits, prescription medicine, dental checkups' },
  { name: 'Other',              scope: 'courier, postage, bank charges, visa fees, and anything that fits nowhere else' },
];
```
(`claim-categories.test.js` tests the suggestion normaliser in `claim-categories.js`, which arrives in Task 18; leave the test file for now — jest will fail on it until then, so move it aside: `mv main/claims/claim-categories.test.js main/claims/claim-categories.test.js.later`.)

`main/routes/users.test.js`:
```js
const request = require('supertest');
const express = require('express');
const { serverFor } = require('../scripts/test-server');

describe('routes/users and routes/company', () => {
  let app, admin, token;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
    app.use('/api/users', require('./users'));
    app.use('/api/company', require('./company'));
    const reg = await request(serverFor(app)).post('/api/auth/register').send({ email: 'wk@solv.sg', password: 'password123' });
    admin = reg.body.user; token = reg.body.token;
  });
  const as = t => ({ Authorization: `Bearer ${t}` });

  test('admin creates staff with roles and a manager; employee cannot create', async () => {
    const m = await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'm@solv.sg', password: 'password123', name: 'Henry', role: 'manager' }).expect(201);
    const e = await request(serverFor(app)).post('/api/users').set(as(token)).send({ email: 'e@solv.sg', password: 'password123', name: 'Elaine', managerId: m.body.user.id, department: 'Sales' }).expect(201);
    expect(e.body.user.managerId).toBe(m.body.user.id);
    const login = await request(serverFor(app)).post('/api/auth/login').send({ email: 'e@solv.sg', password: 'password123' });
    await request(serverFor(app)).post('/api/users').set(as(login.body.token)).send({ email: 'x@solv.sg', password: 'password123' }).expect(403);
    const list = await request(serverFor(app)).get('/api/users').set(as(login.body.token)).expect(200);
    expect(list.body.users.map(u => u.email).sort()).toEqual(['e@solv.sg', 'm@solv.sg', 'wk@solv.sg']);
    expect(list.body.users[0].managerId).toBeUndefined();   // the short directory shape
  });

  test('company settings are readable by all and writable by admin/finance; reader keys are masked', async () => {
    const c = await request(serverFor(app)).get('/api/company').set(as(token)).expect(200);
    expect(c.body.company.baseCurrency).toBe('SGD');
    expect(c.body.categories).toContain('Lodging');
    await request(serverFor(app)).patch('/api/company').set(as(token)).send({ name: 'Solv Pte Ltd', reportColumns: ['Lodging', 'Meals', 'Other'] }).expect(200);
    await request(serverFor(app)).patch('/api/company').set(as(token)).send({ fxPolicy: 'bogus' }).expect(400);
    await request(serverFor(app)).post('/api/company/llm-keys').set(as(token)).send({ apiKey: 'AIzaSy-1234567890', label: 'main' }).expect(201);
    const keys = await request(serverFor(app)).get('/api/company/llm-keys').set(as(token)).expect(200);
    expect(keys.body.keys[0].keyMasked).toMatch(/••••/);
    expect(JSON.stringify(keys.body)).not.toContain('AIzaSy-1234567890');
  });
});
```

Run: `npx jest main/routes`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(auth): companies, roles, staff directory, company settings and reader keys"
```

### Task 5: Gemini client with company-wide keys

**Files:**
- Create (copied, adapted): `main/utils/gemini-client.js`, `main/utils/gemini-client.test.js`

- [ ] **Step 1: Copy and adapt key resolution**

```bash
cp "$XERO/main/utils/gemini-client.js" main/utils/gemini-client.js
cp "$XERO/main/utils/gemini-client.test.js" main/utils/gemini-client.test.js
```
Replace `_resolveKeys` in `main/utils/gemini-client.js` with:
```js
// Keys are company-wide: the company's keys in rotation order, then the .env
// fallback. The limiter below is keyed by company too, because the quota is
// the key's, not the user's.
function _resolveKeys(userId) {
  const keys = [];
  if (userId) {
    const { getGeminiKeysForUser } = require('./users');
    for (const row of getGeminiKeysForUser(userId)) keys.push(row.apiKey);
  }
  if (!keys.length && process.env.Gemini_API_KEY) keys.push(process.env.Gemini_API_KEY);
  if (!keys.length) throw new Error('No Gemini API key configured — add one in Settings');
  return keys;
}
function _limiterKey(userId) {
  if (!userId) return 'default';
  try { const u = require('./users').findById(userId); return u ? `company:${u.companyId}` : String(userId); }
  catch { return String(userId); }
}
```
and change `_getLimiter(userId)` to use `const key = _limiterKey(userId);`.

- [ ] **Step 2: Adapt the ported test**

Open `main/utils/gemini-client.test.js`; wherever it mocks `./users` with `getGeminiKeys`/`getUserConfig`, change the mock to `getGeminiKeysForUser: jest.fn(() => [...])` and `findById: jest.fn(() => ({ companyId: 'c1' }))`, keeping every assertion. Run: `npx jest main/utils/gemini-client.test.js` → PASS.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "port(gemini): client with company-wide keys and per-company rate limit"
```

### Task 6: Job runner (disk queue and worker)

**Files:**
- Create (copied): `main/claims/claim-queue.js`, `claim-queue.test.js`, `main/claims/claim-worker.js`, `main/jobs/index.js`, `main/jobs/jobs.test.js`

- [ ] **Step 1: Copy, and make the worker's claim-import registration lazy**

```bash
mkdir -p main/jobs
cp "$XERO/main/claims/claim-queue.js" main/claims/
cp "$XERO/main/claims/claim-queue.test.js" main/claims/
cp "$XERO/main/claims/claim-worker.js" main/claims/
cp "$XERO/main/jobs/index.js" main/jobs/index.js
cp "$XERO/main/jobs/jobs.test.js" main/jobs/jobs.test.js
```
In `main/claims/claim-worker.js`, delete the top-level requires of `./claim-import`, `../utils/receipt-store`, `../utils/receipt-parser`, `./claim-categories`, and replace the whole `registerJobType('claim-import', {...})` block with:
```js
// claim-import registers itself (see claims/claim-import.js) so this runner
// has no reason to load the reader, the store or the model at boot.
```
Then in `main/claims/claim-queue.test.js`, any test that relies on the claim-import handler being registered by default must stub one: at the top of each such test add
```js
claimWorker.registerJobType('claim-import', { run: ({ deps }) => deps.onSettle({ id: 'x', stage: 'done' }), defaultDeps: () => ({}) });
```
Run: `npx jest main/claims main/jobs` → PASS (the queue tests that only exercise enqueue/read/sweep need no stub).

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "port(jobs): durable per-user job queue and worker"
```

### Task 7: Receipt store, thumbnails, pairing, PDF text pages

**Files:**
- Create (copied): `main/utils/{receipt-store,thumbnailer,pairing,pdf-pages}.js` and their tests

- [ ] **Step 1: Copy and raise the size cap**

```bash
for f in receipt-store thumbnailer pairing pdf-pages; do cp "$XERO/main/utils/$f.js" main/utils/; cp "$XERO/main/utils/$f.test.js" main/utils/; done
```
In `main/utils/receipt-store.js` change the cap and its comment:
```js
// Originals are kept at full size. Xero's 3 MB attachment limit applies to the
// copy made when a report is posted (xero/attachments.js), not to storage.
const MAX_BYTES = 15 * 1024 * 1024;
```
In `main/utils/receipt-store.test.js` update the one test that asserts the 3 MB limit to use `MAX_BYTES + 1` and expect the message to contain `15728640`.

Run: `npx jest main/utils` → PASS.

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "port(files): receipt store (15 MB originals), thumbnails, QR pairing, PDF text pages"
```

### Task 8: Server entry point, health, boot recovery, CI

**Files:**
- Create: `main/index.js`, `main/routes/dashboard.js` (copied), `.github/workflows/ci.yml`, `ecosystem.config.js` (copied, renamed)

- [ ] **Step 1: Copy dashboard route and pm2 config**

```bash
cp "$XERO/main/routes/dashboard.js" main/routes/dashboard.js
cp "$XERO/ecosystem.config.js" ecosystem.config.js
sed -i '' "s/'xero-invoice-app'/'solv-expense'/" ecosystem.config.js
mkdir -p .github/workflows
cp "$XERO/.github/workflows/ci.yml" .github/workflows/ci.yml
```

- [ ] **Step 2: Write main/index.js**

```js
function fatal(kind, msg) {
  console.error(`${kind}:`, msg);
  try { require('./utils/logger').error(kind, { error: msg }); } catch {}
  setTimeout(() => process.exit(1), 1500).unref();
}
process.on('uncaughtException', err => {
  if (err.code === 'EADDRINUSE') { console.error(`Port ${process.env.PORT || 4000} is already in use.`); process.exit(1); }
  fatal('FATAL CRASH', `${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', err => fatal('FATAL REJECTION', err?.stack || err?.message || String(err)));

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express     = require('express');
const path        = require('path');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const morgan      = require('morgan');
const logger      = require('./utils/logger');
const { rateLimitKey } = require('./middleware/rate-limit-key');

require('./db/migrate').run();

const app  = express();
const PORT = process.env.PORT || 4000;
const PROD = process.env.NODE_ENV === 'production';

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'], fontSrc: ["'self'"], connectSrc: ["'self'"],
      frameSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'self'"],
    },
  },
}));
app.use(compression());
app.set('trust proxy', 1);
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, keyGenerator: rateLimitKey, standardHeaders: true, legacyHeaders: false,
                    message: { error: 'Too many requests — slow down' } }));
// Files arrive as base64 inside JSON (4/3 inflation): 25 MB carries a 15 MB original.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/company',   require('./routes/company'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.get('/dashboard/health', require('./routes/dashboard').health);
// Mounted as they arrive in later tasks:
for (const [mount, file] of [['/api/receipts', './routes/receipts'], ['/api/expenses', './routes/expenses'], ['/api/claims', './routes/claims']]) {
  try { app.use(mount, require(file)); } catch (err) { if (err.code !== 'MODULE_NOT_FOUND') throw err; }
}

const UI_DIST = path.join(__dirname, '../ui/dist');
if (PROD) {
  app.use(express.static(UI_DIST, {
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith(path.sep + 'index.html')) res.setHeader('Cache-Control', 'no-store, must-revalidate');
      else if (filePath.includes(path.sep + 'assets' + path.sep)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  app.use('/assets', (_req, res) => res.status(404).type('text/plain').send('Asset not found'));
  app.all('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (_req, res) => { res.setHeader('Cache-Control', 'no-store, must-revalidate'); res.sendFile(path.join(UI_DIST, 'index.html')); });
} else {
  app.all('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('/', (_req, res) => res.json({ app: 'Solv Expense Claims API', status: 'running', ui: 'npm run dev:ui', health: '/dashboard/health' }));
}

app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

const HOST = process.env.HOST || (PROD ? '127.0.0.1' : '0.0.0.0');
app.listen(PORT, HOST, () => {
  logger.info(`Solv server running on ${HOST}:${PORT} [${process.env.NODE_ENV || 'development'}]`);
  try { require('./claims/claim-worker').recoverPendingJobs(); } catch (err) { logger.warn('Job recovery skipped', { error: err.message }); }
});

module.exports = app;
```

- [ ] **Step 3: Boot it once**

Run: `JWT_SECRET=dev ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) PORT=4011 timeout 5 node main/index.js; curl -s localhost:4011/dashboard/health`
Expected: the log line "Solv server running", then `{"status":"healthy",...}` (the timeout ends the process; the curl may need to run in a second shell — alternatively start with `&`, curl, then `kill %1`).

- [ ] **Step 4: Run the whole suite and commit**

Run: `npm test`
Expected: PASS, no failing files.
```bash
git add -A && git commit -m "feat(server): Solv entry point, health, boot recovery, CI"
```

---

## Phase 1 — Intake and reading (server)

### Task 9: Intake normalisers and duplicate detection

**Files:**
- Create (copied): `main/intake/document.js`, `main/intake/document.test.js` (if present), `main/intake/dedup.js`, `main/intake/dedup.test.js` (if present)

- [ ] **Step 1: Copy**

```bash
mkdir -p main/intake
cp "$XERO/main/intake/document.js" main/intake/document.js
cp "$XERO/main/intake/dedup.js" main/intake/dedup.js
for t in document dedup intake; do [ -f "$XERO/main/intake/$t.test.js" ] && cp "$XERO/main/intake/$t.test.js" main/intake/; done
```
`intake.test.js` exercises the bill/invoice pipeline that Solv does not carry; if it requires `./invoice-intake` or `../email/*`, delete it: `rm -f main/intake/intake.test.js`. `dedup.js` needs no change: it takes any store exposing `findByReceiptHash`, `findStored` (optional) and `getAll` — Task 10 supplies that view.

Run: `npx jest main/intake` → PASS (or no tests, if none were shipped for these two files).

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "port(intake): number/date/currency normalisers and duplicate signals"
```

### Task 10: The expense store

**Files:**
- Create: `main/store/expenses.js`, `main/store/expenses.test.js`

- [ ] **Step 1: Write the failing test**

`main/store/expenses.test.js`:
```js
describe('store/expenses', () => {
  let store, users, u;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    store = require('./expenses');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
  });
  const rc = (extra = {}) => store.createReceipt({ companyId: u.companyId, userId: u.id, file: 'r.jpg', mime: 'image/jpeg', sizeBytes: 10, sha256: 'abc', ...extra });

  test('a receipt and an expense are created and read back in camelCase with dollars', () => {
    const r = rc();
    const e = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, merchant: 'Courtyard Pune', currency: 'INR', total: 88188.77, tax: 13452.52 });
    const back = store.getExpense(e.id);
    expect(back.status).toBe('reading');
    expect(back.total).toBe(88188.77);
    expect(back.tax).toBe(13452.52);
    expect(back.receipt).toMatchObject({ id: r.id, file: 'r.jpg', mime: 'image/jpeg' });
    expect(back.lines).toEqual([]);
    expect(store.findReceiptByHash(u.companyId, 'abc').id).toBe(r.id);
    expect(store.findReceiptByHash(u.companyId, 'nope')).toBeNull();
  });

  test('lines must reconcile to the total, to the cent', () => {
    const e = store.createExpense({ companyId: u.companyId, userId: u.id, currency: 'INR', total: 100, status: 'review-needed' });
    expect(() => store.replaceLines(e.id, [{ category: 'Lodging', amount: 60 }, { category: 'Meals', amount: 39.99 }])).toThrow(/99\.99.*100\.00/);
    store.replaceLines(e.id, [{ category: 'Lodging', amount: 60, onBehalfOf: 'Tan Suan Kuan' }, { category: 'Meals', amount: 40 }]);
    const lines = store.getExpense(e.id).lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ category: 'Lodging', amount: 60, onBehalfOf: 'Tan Suan Kuan', currency: 'INR', sortOrder: 0 });
    expect(lines[1].amount).toBe(40);
  });

  test('update leaves undefined alone, clears null, and bumps updatedAt', () => {
    const e = store.createExpense({ companyId: u.companyId, userId: u.id, merchant: 'A', purpose: 'x', total: 5 });
    const upd = store.updateExpense(e.id, { merchant: undefined, purpose: null, total: 6 });
    expect(upd.merchant).toBe('A');
    expect(upd.purpose).toBeNull();
    expect(upd.total).toBe(6);
    expect(upd.updatedAt).toBeTruthy();
  });

  test('listExpenses filters by user, status, unfiled and date range', () => {
    const other = { companyId: u.companyId, userId: u.id };
    store.createExpense({ ...other, receiptDate: '2026-09-01', status: 'review-needed', total: 1 });
    store.createExpense({ ...other, receiptDate: '2026-09-10', status: 'reviewed', total: 2 });
    expect(store.listExpenses({ userId: u.id })).toHaveLength(2);
    expect(store.listExpenses({ userId: u.id, status: 'reviewed' })).toHaveLength(1);
    expect(store.listExpenses({ userId: u.id, from: '2026-09-05' })).toHaveLength(1);
    expect(store.listExpenses({ userId: u.id, unfiled: true })).toHaveLength(2);
  });

  test('deleting the last expense on a receipt reports the receipt is unreferenced', () => {
    const r = rc();
    const a = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, total: 1 });
    const b = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, total: 2 });
    store.deleteExpense(a.id);
    expect(store.countExpensesForReceipt(r.id)).toBe(1);
    store.deleteExpense(b.id);
    expect(store.countExpensesForReceipt(r.id)).toBe(0);
    store.deleteReceipt(r.id);
    expect(store.getReceipt(r.id)).toBeNull();
  });

  test('dedupView speaks the shape intake/dedup expects', () => {
    const r = rc({ sha256: 'h1' });
    store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, merchant: 'Grab', receiptDate: '2026-09-01', total: 18.4, status: 'review-needed' });
    const view = store.dedupView(u.companyId);
    expect(view.findByReceiptHash('h1')).toMatchObject({ vendorName: 'Grab', totalAmount: 18.4 });
    expect(view.getAll()[0]).toMatchObject({ vendorName: 'Grab', invoiceDate: '2026-09-01', totalAmount: 18.4, status: 'review-needed' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest main/store` → FAIL, cannot find module './expenses'.

- [ ] **Step 3: Write store/expenses.js**

```js
const db = require('../db');
const { newId } = require('../utils/ids');

// Every write to receipts, expenses and expense_lines goes through here. Money
// is cents in SQLite and dollars at this boundary, as in the Xero app's store.
const toCents   = v => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100));
const toDollars = c => (c === null || c === undefined ? null : Math.round(c) / 100);
const now = () => new Date().toISOString();

// ── Receipts ─────────────────────────────────────────────────────────────────
function _receipt(row) {
  if (!row) return null;
  return {
    id: row.id, companyId: row.company_id, userId: row.user_id, file: row.file, mime: row.mime, sizeBytes: row.size_bytes,
    sha256: row.sha256, pages: row.pages, source: row.source, groupId: row.group_id, originalName: row.original_name,
    receivedAt: row.received_at, parsedAt: row.parsed_at,
  };
}

function createReceipt({ id = newId(), companyId, userId, file, mime, sizeBytes = 0, sha256 = null, pages = null, source = 'upload', groupId = null, originalName = null }) {
  db.prepare(`INSERT INTO receipts (id, company_id, user_id, file, mime, size_bytes, sha256, pages, source, group_id, original_name, received_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, companyId, userId, file, mime, sizeBytes, sha256, pages, source, groupId, originalName ? String(originalName).slice(0, 200) : null, now());
  return getReceipt(id);
}
function getReceipt(id) { return _receipt(db.prepare('SELECT * FROM receipts WHERE id = ?').get(id)); }
function findReceiptByHash(companyId, sha256) {
  if (!sha256) return null;
  return _receipt(db.prepare('SELECT * FROM receipts WHERE company_id = ? AND sha256 = ? ORDER BY received_at LIMIT 1').get(companyId, sha256));
}
const RECEIPT_COLS = { pages: 'pages', parsedAt: 'parsed_at', parseJson: 'parse_json', groupId: 'group_id', sha256: 'sha256' };
function updateReceipt(id, patch) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries(RECEIPT_COLS)) {
    if (patch[k] === undefined) continue;
    sets.push(`${col} = ?`); args.push(k === 'parseJson' && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]);
  }
  if (sets.length) db.prepare(`UPDATE receipts SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return getReceipt(id);
}
function deleteReceipt(id) { db.prepare('DELETE FROM receipts WHERE id = ?').run(id); }
function countExpensesForReceipt(receiptId) { return db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE receipt_id = ?').get(receiptId).n; }
function countExpensesForFile(userId, file) {
  return db.prepare('SELECT COUNT(*) AS n FROM expenses e JOIN receipts r ON r.id = e.receipt_id WHERE r.user_id = ? AND r.file = ?').get(userId, file).n;
}

// ── Lines ────────────────────────────────────────────────────────────────────
function _line(row) {
  return {
    id: row.id, expenseId: row.expense_id, sortOrder: row.sort_order, category: row.category, description: row.description,
    amount: toDollars(row.amount_cents), currency: row.currency,
    fxRate: row.fx_rate, fxRateDate: row.fx_rate_date, fxSource: row.fx_source, fxFetchedAt: row.fx_fetched_at, fxPolicy: row.fx_policy,
    fxOverrideBy: row.fx_override_by, fxOverrideReason: row.fx_override_reason, baseAmount: toDollars(row.base_cents),
    onBehalfOf: row.on_behalf_of, accountCode: row.account_code,
  };
}
function getLines(expenseId) {
  return db.prepare('SELECT * FROM expense_lines WHERE expense_id = ? ORDER BY sort_order, id').all(expenseId).map(_line);
}
function linesReconcile(lines, totalCents) {
  const sum = (lines || []).reduce((s, l) => s + (toCents(l.amount) || 0), 0);
  return sum === totalCents;
}
// Replaces every line. The lines must sum to the expense total, to the cent —
// that is the whole point of a split — unless `force` says the caller is
// mid-edit and will reconcile later.
function replaceLines(expenseId, lines, { force = false } = {}) {
  const exp = db.prepare('SELECT total_cents, currency FROM expenses WHERE id = ?').get(expenseId);
  if (!exp) throw new Error('Expense not found');
  const list = (lines || []).map(l => ({ ...l, cents: toCents(l.amount) || 0 }));
  const sum = list.reduce((s, l) => s + l.cents, 0);
  if (!force && sum !== exp.total_cents) {
    throw new Error(`Lines total ${(sum / 100).toFixed(2)} but the receipt total is ${(exp.total_cents / 100).toFixed(2)}`);
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM expense_lines WHERE expense_id = ?').run(expenseId);
    const ins = db.prepare(`INSERT INTO expense_lines (expense_id, sort_order, category, description, amount_cents, currency,
      fx_rate, fx_rate_date, fx_source, fx_fetched_at, fx_policy, fx_override_by, fx_override_reason, base_cents, on_behalf_of, account_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    list.forEach((l, i) => ins.run(expenseId, i, l.category || null, l.description ? String(l.description).slice(0, 250) : null, l.cents,
      l.currency || exp.currency || null, l.fxRate ?? null, l.fxRateDate ?? null, l.fxSource ?? null, l.fxFetchedAt ?? null, l.fxPolicy ?? null,
      l.fxOverrideBy ?? null, l.fxOverrideReason ?? null, toCents(l.baseAmount), l.onBehalfOf ? String(l.onBehalfOf).slice(0, 80) : null, l.accountCode ?? null));
  });
  tx();
  return getLines(expenseId);
}
const LINE_COLS = { category: 'category', description: 'description', onBehalfOf: 'on_behalf_of', accountCode: 'account_code',
  fxRate: 'fx_rate', fxRateDate: 'fx_rate_date', fxSource: 'fx_source', fxFetchedAt: 'fx_fetched_at', fxPolicy: 'fx_policy',
  fxOverrideBy: 'fx_override_by', fxOverrideReason: 'fx_override_reason' };
function updateLine(lineId, patch) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries(LINE_COLS)) { if (patch[k] === undefined) continue; sets.push(`${col} = ?`); args.push(patch[k]); }
  if (patch.baseAmount !== undefined) { sets.push('base_cents = ?'); args.push(toCents(patch.baseAmount)); }
  if (sets.length) db.prepare(`UPDATE expense_lines SET ${sets.join(', ')} WHERE id = ?`).run(...args, lineId);
  return _line(db.prepare('SELECT * FROM expense_lines WHERE id = ?').get(lineId));
}

// ── Expenses ─────────────────────────────────────────────────────────────────
const EXPENSE_COLS = {
  receiptId: 'receipt_id', reportId: 'report_id', merchant: 'merchant', receiptDate: 'receipt_date', receiptTime: 'receipt_time',
  invoiceNo: 'invoice_no', currency: 'currency', purpose: 'purpose', description: 'description', category: 'category', status: 'status',
  duplicateOf: 'duplicate_of', errorMsg: 'error_msg', aiReadAt: 'ai_read_at', aiConfidence: 'ai_confidence', page: 'page', source: 'source',
};
const MONEY = { total: 'total_cents', tax: 'tax_cents', subTotal: 'subtotal_cents' };

function _expense(row, lines, receipt) {
  if (!row) return null;
  let box = null;
  try { box = row.box ? JSON.parse(row.box) : null; } catch { box = null; }
  return {
    id: row.id, companyId: row.company_id, userId: row.user_id, receiptId: row.receipt_id, reportId: row.report_id,
    merchant: row.merchant, receiptDate: row.receipt_date, receiptTime: row.receipt_time, invoiceNo: row.invoice_no, currency: row.currency,
    total: toDollars(row.total_cents) ?? 0, tax: toDollars(row.tax_cents), subTotal: toDollars(row.subtotal_cents),
    purpose: row.purpose, description: row.description, category: row.category, status: row.status, duplicateOf: row.duplicate_of,
    errorMsg: row.error_msg, aiReadAt: row.ai_read_at, aiConfidence: row.ai_confidence, box, page: row.page, source: row.source,
    createdAt: row.created_at, updatedAt: row.updated_at, lines: lines || [], receipt: receipt || null,
  };
}
function _hydrate(row) {
  if (!row) return null;
  return _expense(row, getLines(row.id), row.receipt_id ? getReceipt(row.receipt_id) : null);
}

function createExpense({ id = newId(), companyId, userId, lines = [], box = null, ...fields }) {
  const cols = ['id', 'company_id', 'user_id', 'created_at', 'box'];
  const vals = [id, companyId, userId, now(), box ? JSON.stringify(box) : null];
  for (const [k, col] of Object.entries(EXPENSE_COLS)) { if (fields[k] === undefined) continue; cols.push(col); vals.push(fields[k]); }
  for (const [k, col] of Object.entries(MONEY)) { if (fields[k] === undefined) continue; cols.push(col); vals.push(toCents(fields[k])); }
  if (!cols.includes('status')) { cols.push('status'); vals.push('reading'); }
  db.prepare(`INSERT INTO expenses (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  if (lines.length) replaceLines(id, lines, { force: true });
  return getExpense(id);
}
function getExpense(id) { return _hydrate(db.prepare('SELECT * FROM expenses WHERE id = ?').get(id)); }

function updateExpense(id, patch) {
  const sets = [], args = [];
  for (const [k, col] of Object.entries(EXPENSE_COLS)) { if (patch[k] === undefined) continue; sets.push(`${col} = ?`); args.push(patch[k]); }
  for (const [k, col] of Object.entries(MONEY)) { if (patch[k] === undefined) continue; sets.push(`${col} = ?`); args.push(toCents(patch[k]) ?? (k === 'total' ? 0 : null)); }
  if (patch.box !== undefined) { sets.push('box = ?'); args.push(patch.box ? JSON.stringify(patch.box) : null); }
  sets.push('updated_at = ?'); args.push(now());
  db.prepare(`UPDATE expenses SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return getExpense(id);
}

function listExpenses({ companyId, userId, status, reportId, unfiled, from, to, receiptId, groupId } = {}) {
  const where = [], args = [];
  if (companyId) { where.push('e.company_id = ?'); args.push(companyId); }
  if (userId)    { where.push('e.user_id = ?'); args.push(userId); }
  if (status)    { where.push('e.status = ?'); args.push(status); }
  if (reportId)  { where.push('e.report_id = ?'); args.push(reportId); }
  if (unfiled)   { where.push('e.report_id IS NULL'); }
  if (from)      { where.push('e.receipt_date >= ?'); args.push(from); }
  if (to)        { where.push('e.receipt_date <= ?'); args.push(to); }
  if (receiptId) { where.push('e.receipt_id = ?'); args.push(receiptId); }
  if (groupId)   { where.push('e.receipt_id IN (SELECT id FROM receipts WHERE group_id = ?)'); args.push(groupId); }
  const sql = `SELECT e.* FROM expenses e ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.receipt_date DESC, e.created_at DESC`;
  return db.prepare(sql).all(...args).map(_hydrate);
}
function expensesForReceipt(receiptId) { return listExpenses({ receiptId }); }
function deleteExpense(id) { db.prepare('DELETE FROM expenses WHERE id = ?').run(id); }

// The shape intake/dedup.js reads: vendorName, invoiceDate, totalAmount, status,
// plus findByReceiptHash. Scoped to the company so one person's duplicate of a
// colleague's receipt (the same folio uploaded by both) is caught too.
function dedupView(companyId) {
  const shape = e => e && ({ id: e.id, vendorName: e.merchant, invoiceDate: e.receiptDate, totalAmount: e.total, status: e.status, invoiceNumber: e.invoiceNo, receiptFile: e.receipt && e.receipt.file, receiptMime: e.receipt && e.receipt.mime, receiptId: e.receiptId, userId: e.userId });
  return {
    findByReceiptHash(hash) {
      const r = findReceiptByHash(companyId, hash);
      if (!r) return null;
      const e = db.prepare('SELECT * FROM expenses WHERE receipt_id = ? ORDER BY created_at LIMIT 1').get(r.id);
      return e ? shape(_hydrate(e)) : { id: null, receiptId: r.id, receiptFile: r.file, receiptMime: r.mime, userId: r.userId };
    },
    getAll() { return listExpenses({ companyId }).map(shape); },
  };
}

module.exports = {
  createReceipt, getReceipt, findReceiptByHash, updateReceipt, deleteReceipt, countExpensesForReceipt, countExpensesForFile,
  createExpense, getExpense, updateExpense, listExpenses, expensesForReceipt, deleteExpense,
  getLines, replaceLines, updateLine, linesReconcile, dedupView, toCents, toDollars,
};
```

- [ ] **Step 4: Run the test**

Run: `npx jest main/store` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(store): receipts, expenses and reconciled category lines"
```

### Task 11: PDF page renderer (child process)

**Files:**
- Create: `main/utils/pdf-render-worker.mjs`, `main/utils/pdf-render.js`, `main/utils/pdf-render.test.js`

- [ ] **Step 1: Write the failing test**

`main/utils/pdf-render.test.js`:
```js
const fs   = require('fs');
const path = require('path');
const PdfPrinter = require('pdfmake');

// A real two-page PDF, built here so the test never depends on a fixture file.
async function twoPagePdf() {
  const fonts = { Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } };
  const doc = new PdfPrinter(fonts).createPdfKitDocument({
    defaultStyle: { font: 'Helvetica' },
    content: [{ text: 'TAX INVOICE page one', fontSize: 20 }, { text: 'second page', pageBreak: 'before', fontSize: 20 }],
  });
  const chunks = [];
  return new Promise(resolve => { doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.end(); });
}

describe('utils/pdf-render', () => {
  const { renderPdfPages } = require('./pdf-render');

  test('renders every page to a JPEG of A4 proportions at 150 dpi', async () => {
    const out = await renderPdfPages(await twoPagePdf());
    expect(out.numPages).toBe(2);
    expect(out.pages).toHaveLength(2);
    for (const p of out.pages) {
      expect(p.buffer[0]).toBe(0xff); expect(p.buffer[1]).toBe(0xd8);   // JPEG magic
      expect(p.width).toBeGreaterThan(1100); expect(p.width).toBeLessThan(1300);
      expect(p.height).toBeGreaterThan(p.width);
    }
  }, 60000);

  test('maxPages caps the work', async () => {
    const out = await renderPdfPages(await twoPagePdf(), { maxPages: 1 });
    expect(out.numPages).toBe(2);
    expect(out.pages).toHaveLength(1);
  }, 60000);

  test('garbage bytes return null rather than throwing', async () => {
    expect(await renderPdfPages(Buffer.from('not a pdf'))).toBeNull();
    expect(await renderPdfPages(Buffer.alloc(0))).toBeNull();
  }, 60000);

  const sample = path.join(__dirname, '../../samples/receipts/jw-marriott-mumbai.pdf');
  (fs.existsSync(sample) ? test : test.skip)('the scanned Mumbai folio renders both pages', async () => {
    const out = await renderPdfPages(fs.readFileSync(sample));
    expect(out.numPages).toBe(2);
    expect(out.pages[0].buffer.length).toBeGreaterThan(50000);
  }, 90000);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest main/utils/pdf-render.test.js` → FAIL, cannot find module './pdf-render'.

- [ ] **Step 3: Write the worker**

`main/utils/pdf-render-worker.mjs`:
```js
// Renders every page of a PDF to a JPEG file. Runs as a child process of
// pdf-render.js: pdfjs is ESM-only and heavy, and a render that blows up must
// not take the server with it.
//
// Usage: node pdf-render-worker.mjs <input.pdf> <outDir> <dpi> <maxPages>
// Prints one JSON line: { numPages, rendered: [{ page, file, width, height }] }
import fs from 'node:fs';
import path from 'node:path';

const [,, input, outDir, dpiArg = '150', maxArg = '20'] = process.argv;
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const data = new Uint8Array(fs.readFileSync(input));
const doc  = await getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
const scale = Number(dpiArg) / 72;
const n = Math.min(doc.numPages, Number(maxArg));
fs.mkdirSync(outDir, { recursive: true });

const rendered = [];
for (let i = 1; i <= n; i++) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
  // The document's own canvas factory: pdfjs wires it to @napi-rs/canvas under Node.
  const cc = doc.canvasFactory.create(width, height);
  cc.context.fillStyle = '#ffffff';
  cc.context.fillRect(0, 0, width, height);
  await page.render({ canvasContext: cc.context, viewport }).promise;
  const file = path.join(outDir, `page-${i}.jpg`);
  fs.writeFileSync(file, cc.canvas.toBuffer('image/jpeg', 85));
  rendered.push({ page: i, file, width, height });
  doc.canvasFactory.destroy(cc);
  page.cleanup();
}
await doc.destroy();
process.stdout.write(JSON.stringify({ numPages: doc.numPages, rendered }));
```
If pdfjs's factory does not expose `create` in the installed version, replace the three factory lines with `import { createCanvas } from '@napi-rs/canvas'` and `const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');`, passing `canvasContext: ctx` and writing `canvas.toBuffer('image/jpeg', 85)`; the test decides.

- [ ] **Step 4: Write the wrapper**

`main/utils/pdf-render.js`:
```js
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
```

- [ ] **Step 5: Run the test**

Run: `npx jest main/utils/pdf-render.test.js` → PASS (all four, the Sample one included on this machine).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(reader): scanned PDF pages rendered to JPEG in a child process"
```

### Task 12: Reader: invoice number, line categories, on-behalf, one document across pages

**Files:**
- Create (copied, then extended): `main/utils/receipt-parser.js`, `main/utils/receipt-parser.test.js`, `main/utils/receipt-parser-lines.test.js`

- [ ] **Step 1: Copy and run the ported tests**

```bash
cp "$XERO/main/utils/receipt-parser.js" main/utils/
cp "$XERO/main/utils/receipt-parser.test.js" main/utils/
cp "$XERO/main/utils/receipt-parser-lines.test.js" main/utils/
```
Run: `npx jest main/utils/receipt-parser` → PASS (they mock `./gemini-client`).

- [ ] **Step 2: Add the failing tests for the extensions**

Append to `main/utils/receipt-parser.test.js`:
```js
describe('receipt-parser — Solv extensions', () => {
  const gemini = require('./gemini-client');
  const parser = require('./receipt-parser');

  test('normalise keeps the invoice number, a category and on-behalf name per line', () => {
    const r = parser.normalise({
      merchant: 'Courtyard By Marriott Pune Chakan', date: '2026-09-04', currency: 'INR', total: 88188.77, invoiceNumber: '93/713-181024',
      category: 'Lodging', confidence: 'high',
      lineItems: [
        { description: 'Package', unitAmount: 12825, category: 'Lodging' },
        { description: 'CGST ROOM 9%', unitAmount: 1154.25, category: 'lodging' },
        { description: 'Standard Retail', unitAmount: 10925, category: 'Lodging', onBehalfOf: 'TAN SUAN KUAN' },
        { description: 'MoMo Cafe Dinner Food', unitAmount: 1296.25, category: 'Meals' },
        { description: 'Mystery', unitAmount: 1, category: 'Not A Category' },
      ],
    });
    expect(r.invoiceNumber).toBe('93/713-181024');
    expect(r.lineItems.map(l => l.category)).toEqual(['Lodging', 'Lodging', 'Lodging', 'Meals', null]);
    expect(r.lineItems[2].onBehalfOf).toBe('TAN SUAN KUAN');
    expect(r.lineItems[0].onBehalfOf).toBeNull();
  });

  test('parseReceiptPages sends every page in one call and never splits', async () => {
    gemini.callGemini.mockResolvedValueOnce(JSON.stringify({ receipts: [
      { merchant: 'JW Marriott Mumbai Sahar', date: '2026-09-01', currency: 'INR', total: 44309, category: 'Lodging', confidence: 'high', lineItems: [] },
      { merchant: 'ghost', total: 1 },
    ] }));
    const pages = [{ buffer: Buffer.from('p1'), mime: 'image/jpeg' }, { buffer: Buffer.from('p2'), mime: 'image/jpeg' }];
    const out = await parser.parseReceiptPages('u1', pages);
    expect(out.split).toBe(false);
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0].merchant).toBe('JW Marriott Mumbai Sahar');
    const messages = gemini.callGemini.mock.calls.at(-1)[1];
    const parts = messages[1].content;
    expect(parts.filter(p => p.type === 'image_url')).toHaveLength(2);
    expect(parts[0].text).toMatch(/ONE document/);
  });

  test('parseReceiptPages with one page behaves like a single image read', async () => {
    gemini.callGemini.mockResolvedValueOnce(JSON.stringify({ receipts: [{ merchant: 'Grab', total: 18.4, currency: 'SGD', confidence: 'high' }] }));
    const out = await parser.parseReceiptPages('u1', [{ buffer: Buffer.from('p1'), mime: 'image/jpeg' }]);
    expect(out.receipts[0].merchant).toBe('Grab');
  });
});
```
Confirm the file's existing `jest.mock('./gemini-client', ...)` exposes `callGemini` as a `jest.fn()`; if it mocks with a factory returning a plain function, change it to `callGemini: jest.fn()`.

Run: `npx jest main/utils/receipt-parser.test.js` → FAIL on the three new tests.

- [ ] **Step 3: Extend the prompt**

In `SYSTEM_PROMPT` of `main/utils/receipt-parser.js`, after the `subTotal` bullet add:
```
- invoiceNumber: the invoice, bill, folio or receipt number printed on the document (e.g. "93/713-181024"), null if none.
```
and replace the `lineItems` bullet's object shape with:
```
    [
      {
        "description": "item description or dish name",
        "unitAmount": the price of ONE unit as a plain number (e.g. 1.60),
        "quantity": item quantity if shown (e.g. 1, 6), default 1,
        "lineTotal": the amount printed on that line (quantity × unit price, e.g. 9.60); same as unitAmount when quantity is 1,
        "discountRate": discount percent if shown, default 0,
        "category": one of the category names above, judged from what THIS line is for. A tax, GST/VAT, service-charge or fee line takes the category of the charge it belongs to (a room's GST is Lodging, a cafe's GST is Meals).
        "onBehalfOf": when the line was transferred from, or paid for, ANOTHER guest or person, that person's name exactly as printed (e.g. "TAN SUAN KUAN #126 => Khoo #110" means the line is for TAN SUAN KUAN); otherwise null.
      }
    ]
  Include EVERY charge line, including each tax line, so the lines add up to the total.
```

- [ ] **Step 4: Extend normalise and add parseReceiptPages**

In `normalise()`, replace the `lineItems` mapping with:
```js
  const lineItems = (Array.isArray(parsed.lineItems) ? parsed.lineItems : [])
    .map(li => {
      const n = _intake.normaliseLineItem(li);
      if (!n) return null;
      return {
        description:  n.description.slice(0, 200),
        unitAmount:   n.unitAmount,
        discountRate: n.discountRate,
        category:     canonicalCategory(li && li.category),
        onBehalfOf:   li && typeof li.onBehalfOf === 'string' && li.onBehalfOf.trim() ? li.onBehalfOf.trim().slice(0, 80) : null,
      };
    })
    .filter(Boolean);
```
and add to the returned object, after `merchant`:
```js
    invoiceNumber: typeof parsed.invoiceNumber === 'string' && parsed.invoiceNumber.trim() ? parsed.invoiceNumber.trim().slice(0, 60) : null,
```
Change `_readWith`'s signature and call to accept a token budget (a folio has forty lines):
```js
async function _readWith(userId, userContent, maxAttempts, { maxTokens = 3000 } = {}) {
  ...
      const content = await callGemini(userId, messages, { temperature: 0, maxTokens });
```
Add after `parseReceiptText`:
```js
// Several page images that are ONE document: a hotel folio, a multi-page
// invoice. Read together, so the total on the last page and the lines on the
// first belong to one receipt. Never split, whatever the model returns.
async function parseReceiptPages(userId, pages, { maxAttempts = 2 } = {}) {
  const list = (pages || []).filter(p => p && Buffer.isBuffer(p.buffer) && p.buffer.length);
  if (!list.length) return null;
  if (list.length === 1) {
    const one = await parseReceiptImage(userId, list[0].buffer, list[0].mime, { maxAttempts });
    return one ? { receipts: [one.receipts[0]], split: false, reason: 'single page' } : null;
  }
  const content = [{ type: 'text', text:
    `These ${list.length} images are the PAGES of ONE document (a hotel folio, an invoice or a statement), in order. ` +
    `Read them together as a single receipt and return { "receipts": [ one entry ] }: one merchant, one invoiceNumber, ` +
    `one total (the final amount charged, usually on the last page), one currency, EVERY line item from EVERY page, and no box_2d. ` +
    `Never return one entry per page.` }];
  list.forEach((p, i) => {
    content.push({ type: 'text', text: `Page ${i + 1} of ${list.length}:` });
    content.push({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.buffer.toString('base64')}` } });
  });
  const result = await _readWith(userId, content, maxAttempts, { maxTokens: 6000 });
  if (!result) return null;
  return { receipts: [result.receipts[0]], split: false, reason: 'pages of one document' };
}
```
and export it: add `parseReceiptPages` to `module.exports`.

- [ ] **Step 5: Run every parser test**

Run: `npx jest main/utils/receipt-parser` → PASS. If a ported test pinned the old `maxTokens: 1200` in an assertion, update that assertion to `3000`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(reader): invoice number, per-line category and on-behalf name, one document across pages"
```

### Task 13: Text PDFs whose pages are one document

**Files:**
- Modify: `main/utils/pdf-pages.js`, `main/utils/pdf-pages.test.js`

- [ ] **Step 1: Add the failing test**

Append to `main/utils/pdf-pages.test.js`:
```js
describe('pdf-pages — sameDocument', () => {
  const { sameDocument, splittablePages } = require('./pdf-pages');
  const folio = n => `COURTYARD BY MARRIOTT PUNE CHAKAN TAX INVOICE Invoice # : 93/713-181024 Page ${n} of 4 charges ...`;

  test('pages sharing an invoice number are one document', () => {
    expect(sameDocument([folio(1), folio(2), folio(3)])).toBe(true);
    expect(splittablePages({ pages: [folio(1), folio(2)], hasText: true })).toMatchObject({ split: false, reason: 'pages of one document' });
  });

  test('pages with different numbers are separate receipts', () => {
    expect(sameDocument(['GRAB Receipt No: A1 total 18.40 for the ride', 'GRAB Receipt No: B2 total 22.10 for the ride'])).toBe(false);
  });

  test('without numbers, a header repeated on every page means one document', () => {
    const head = 'JW MARRIOTT MUMBAI SAHAR TAX INVOICE folio for Ms Khoo';
    expect(sameDocument([`${head} page one lines`, `${head} page two totals`])).toBe(true);
    expect(sameDocument(['Grab ride 18.40 on Monday from home', 'Gojek ride 25.00 on Tuesday from the office'])).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

In `main/utils/pdf-pages.js` add before `splittablePages`:
```js
// Are these text pages ONE document? A hotel folio repeats its invoice number
// on every page; a scan of several receipts does not. Failing a number, a
// header that opens every page is taken as the same document.
const NUMBER_RE = /(?:invoice|bill|receipt|folio|statement)\s*(?:no|number|num|#)?\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9\/-]{2,})/i;
function sameDocument(pages = []) {
  const texts = pages.filter(p => typeof p === 'string' && p.trim().length >= MIN_PAGE_CHARS);
  if (texts.length < 2) return false;
  const nums = texts.map(t => { const m = NUMBER_RE.exec(t); return m ? m[1].toUpperCase() : null; });
  if (nums.every(Boolean)) return new Set(nums).size === 1;
  const norm = t => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const head = norm(texts[0]).slice(0, 48);
  return head.length >= 20 && texts.slice(1).every(t => norm(t).includes(head));
}
```
and at the top of `splittablePages`, after the `!hasText || pages.length < 2` guard:
```js
  if (sameDocument(pages)) return { split: false, pageNumbers: [], reason: 'pages of one document' };
```
Export `sameDocument`.

Run: `npx jest main/utils/pdf-pages.test.js` → PASS.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(reader): text PDFs whose pages share a document number are read as one receipt"
```

### Task 14: The read pipeline

**Files:**
- Create: `main/receipts/read-receipt.js`, `main/receipts/read-receipt.test.js`

- [ ] **Step 1: Write the failing test**

`main/receipts/read-receipt.test.js`:
```js
jest.mock('../utils/receipt-parser', () => ({
  parseReceiptImage: jest.fn(), parseReceiptText: jest.fn(), parseReceiptPages: jest.fn(),
}));
jest.mock('../utils/pdf-render', () => ({ renderPdfPages: jest.fn() }));
jest.mock('../utils/pdf-pages', () => ({
  extractPages: jest.fn(), splittablePages: jest.fn(() => ({ split: false, reason: 'single' })), sameDocument: jest.fn(() => false),
}));

describe('receipts/read-receipt', () => {
  let store, users, u, parser, render, pdfPages, read;
  const folio = {
    merchant: 'Courtyard By Marriott Pune Chakan', date: '2026-09-04', time: '08:23', currency: 'INR', total: 88188.77, tax: 13452.52,
    subTotal: null, invoiceNumber: '93/713-181024', category: 'Lodging', description: '[Lodging] Rooms and meals @ Courtyard', confidence: 'high', box: null,
    lineItems: [
      { description: 'Package', unitAmount: 36552, category: 'Lodging', onBehalfOf: null },
      { description: 'CGST/SGST ROOM', unitAmount: 6579.36, category: 'Lodging', onBehalfOf: null },
      { description: 'Standard Retail', unitAmount: 31113, category: 'Lodging', onBehalfOf: 'TAN SUAN KUAN' },
      { description: 'CGST/SGST ROOM (transfer)', unitAmount: 5600.34, category: 'Lodging', onBehalfOf: 'TAN SUAN KUAN' },
      { description: 'MoMo Cafe', unitAmount: 8344.07, category: 'Meals', onBehalfOf: null },
    ],
  };

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users'); store = require('../store/expenses');
    parser = require('../utils/receipt-parser'); render = require('../utils/pdf-render'); pdfPages = require('../utils/pdf-pages');
    read = require('./read-receipt');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
    [parser.parseReceiptImage, parser.parseReceiptText, parser.parseReceiptPages, render.renderPdfPages, pdfPages.extractPages].forEach(f => f.mockReset());
  });
  const seed = (mime = 'image/jpeg') => {
    const r = store.createReceipt({ companyId: u.companyId, userId: u.id, file: `f.${mime === 'application/pdf' ? 'pdf' : 'jpg'}`, mime, sha256: 'h' });
    const e = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r.id, currency: 'SGD' });
    return { r, e };
  };

  test('buildLines groups by category and on-behalf and reconciles to the cent', () => {
    const lines = read.buildLines(folio, 'Other');
    expect(lines.map(l => [l.category, l.onBehalfOf, l.amount])).toEqual([
      ['Lodging', null, 43131.36], ['Lodging', 'TAN SUAN KUAN', 36713.34], ['Meals', null, 8344.07],
    ]);
    expect(lines.reduce((s, l) => s + Math.round(l.amount * 100), 0)).toBe(8818877);
  });

  test('buildLines falls back to one line when the items do not add up', () => {
    const lines = read.buildLines({ ...folio, lineItems: [{ description: 'x', unitAmount: 5, category: 'Meals' }] }, 'Other');
    expect(lines).toEqual([{ category: 'Lodging', description: '[Lodging] Rooms and meals @ Courtyard', amount: 88188.77, onBehalfOf: null }]);
  });

  test('a scanned PDF is rendered and read as one document across pages', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: ['', '', '', ''], numPages: 4, hasText: false, textPageCount: 0 });
    render.renderPdfPages.mockResolvedValue({ numPages: 4, pages: [1, 2, 3, 4].map(p => ({ page: p, buffer: Buffer.from(`p${p}`), width: 1240, height: 1754 })) });
    parser.parseReceiptPages.mockResolvedValue({ receipts: [folio], split: false, reason: 'pages of one document' });

    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });

    expect(parser.parseReceiptPages).toHaveBeenCalledTimes(1);
    expect(parser.parseReceiptPages.mock.calls[0][1]).toHaveLength(4);
    const after = store.getExpense(e.id);
    expect(after.status).toBe('review-needed');
    expect(after.merchant).toBe('Courtyard By Marriott Pune Chakan');
    expect(after.total).toBe(88188.77);
    expect(after.invoiceNo).toBe('93/713-181024');
    expect(after.currency).toBe('INR');
    expect(after.lines).toHaveLength(3);
    expect(store.listExpenses({ receiptId: r.id })).toHaveLength(1);      // one expense, not four
    expect(store.getReceipt(r.id).pages).toBe(4);
    expect(store.getReceipt(r.id).parsedAt).toBeTruthy();
  });

  test('a scanned PDF that cannot be rendered is left for the user with a note', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: [''], numPages: 1, hasText: false, textPageCount: 0 });
    render.renderPdfPages.mockResolvedValue(null);
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });
    const after = store.getExpense(e.id);
    expect(after.status).toBe('review-needed');
    expect(after.errorMsg).toMatch(/could not be read/i);
    expect(parser.parseReceiptPages).not.toHaveBeenCalled();
  });

  test('a text PDF whose pages are one document is read from the joined text', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: ['page one text', 'page two text'], numPages: 2, hasText: true, textPageCount: 2 });
    pdfPages.splittablePages.mockReturnValue({ split: false, pageNumbers: [], reason: 'pages of one document' });
    parser.parseReceiptText.mockResolvedValue({ receipts: [{ ...folio, lineItems: [] }], split: false });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });
    expect(parser.parseReceiptText.mock.calls[0][1]).toMatch(/page one text[\s\S]*page two text/);
    expect(store.getExpense(e.id).lines).toEqual([expect.objectContaining({ category: 'Lodging', amount: 88188.77 })]);
  });

  test('a text PDF of separate receipts becomes one expense per page', async () => {
    const { r, e } = seed('application/pdf');
    pdfPages.extractPages.mockResolvedValue({ pages: ['grab one', 'grab two'], numPages: 2, hasText: true, textPageCount: 2 });
    pdfPages.splittablePages.mockReturnValue({ split: true, pageNumbers: [1, 2], reason: null });
    parser.parseReceiptText
      .mockResolvedValueOnce({ receipts: [{ merchant: 'Grab', total: 18.4, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }] })
      .mockResolvedValueOnce({ receipts: [{ merchant: 'Gojek', total: 25, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('%PDF'), mime: 'application/pdf' });
    const all = store.listExpenses({ receiptId: r.id }).sort((a, b) => a.page - b.page);
    expect(all.map(x => [x.page, x.merchant])).toEqual([[1, 'Grab'], [2, 'Gojek']]);
  });

  test('a photo of two receipts splits when the parser says the evidence is clean', async () => {
    const { r, e } = seed();
    parser.parseReceiptImage.mockResolvedValue({ split: true, reason: null, receipts: [
      { merchant: 'A', total: 5, currency: 'SGD', category: 'Meals', confidence: 'high', box: [0, 0, 500, 1000], lineItems: [] },
      { merchant: 'B', total: 7, currency: 'SGD', category: 'Meals', confidence: 'high', box: [500, 0, 1000, 1000], lineItems: [] },
    ] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('jpg'), mime: 'image/jpeg' });
    const all = store.listExpenses({ receiptId: r.id }).sort((a, b) => a.merchant.localeCompare(b.merchant));
    expect(all.map(x => [x.merchant, x.box])).toEqual([['A', [0, 0, 500, 1000]], ['B', [500, 0, 1000, 1000]]]);
    expect(all.every(x => x.status === 'review-needed')).toBe(true);
  });

  test('an unreadable photo survives at review-needed with blank fields', async () => {
    const { r, e } = seed();
    parser.parseReceiptImage.mockResolvedValue(null);
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r.id, expenseId: e.id, buffer: Buffer.from('jpg'), mime: 'image/jpeg' });
    const after = store.getExpense(e.id);
    expect(after.status).toBe('review-needed');
    expect(after.merchant).toBeNull();
    expect(store.getReceipt(r.id).parsedAt).toBeTruthy();
  });

  test('a second receipt with the same merchant, date and amount is flagged, never auto-marked', async () => {
    const first = seed();
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Grab', date: '2026-09-01', total: 18.4, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }] });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: first.r.id, expenseId: first.e.id, buffer: Buffer.from('a'), mime: 'image/jpeg' });
    const r2 = store.createReceipt({ companyId: u.companyId, userId: u.id, file: 'g.jpg', mime: 'image/jpeg', sha256: 'h2' });
    const e2 = store.createExpense({ companyId: u.companyId, userId: u.id, receiptId: r2.id });
    await read.readReceipt({ companyId: u.companyId, userId: u.id, receiptId: r2.id, expenseId: e2.id, buffer: Buffer.from('b'), mime: 'image/jpeg' });
    const after = store.getExpense(e2.id);
    expect(after.status).toBe('review-needed');
    expect(after.duplicateOf).toBe(first.e.id);
    expect(after.errorMsg).toMatch(/Possible duplicate/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest main/receipts` → FAIL, cannot find module './read-receipt'.

- [ ] **Step 3: Write receipts/read-receipt.js**

```js
const parser    = require('../utils/receipt-parser');
const pdfPages  = require('../utils/pdf-pages');
const pdfRender = require('../utils/pdf-render');
const store     = require('../store/expenses');
const { findDuplicate } = require('../intake/dedup');
const { canonicalCategory } = require('../claims/categories');
const logger    = require('../utils/logger');

// The one place that decides HOW a stored file is read and what the read does
// to the expense rows. Callers (the upload route, the phone route, the batch
// import, re-read) hand it a receipt that is already on disk.
//
//   photo            → vision; a clean multi-receipt photo splits into siblings
//   PDF with text    → text reader; pages that are one document read together,
//                      otherwise one expense per page
//   PDF without text → pages rendered to images, read together as ONE document
//
// Nothing here throws to the caller: a failure leaves the expense at
// review-needed with blank fields and a note, never lost.

// Above this many pages a scan is a stack of separate receipts, not one folio.
const MAX_PAGES_ONE_DOC = 10;

// One line per (category, on-behalf-of), summing exactly to the total. The
// reader's items rarely add up to the cent, so the residual goes to the
// largest line. Items that are nowhere near the total are not trusted, and the
// whole total sits on one line at the receipt's own category.
function buildLines(r, fallbackCategory) {
  const totalCents = Math.round((Number(r.total) || 0) * 100);
  if (totalCents <= 0) return [];
  const cat = canonicalCategory(r.category) || fallbackCategory || 'Other';
  const items = Array.isArray(r.lineItems) ? r.lineItems.filter(li => li && Number.isFinite(Number(li.unitAmount))) : [];

  const groups = new Map();
  for (const li of items) {
    const category = canonicalCategory(li.category) || cat;
    const onBehalfOf = li.onBehalfOf || null;
    const key = `${category}|${onBehalfOf || ''}`;
    const g = groups.get(key) || { category, onBehalfOf, cents: 0, names: [] };
    g.cents += Math.round(Number(li.unitAmount) * 100);
    if (li.description && g.names.length < 3 && !g.names.includes(li.description)) g.names.push(li.description);
    groups.set(key, g);
  }
  const lines = [...groups.values()].filter(g => g.cents > 0);
  const sum = lines.reduce((s, g) => s + g.cents, 0);
  const tolerance = Math.max(100, Math.round(totalCents * 0.15));
  if (!lines.length || Math.abs(sum - totalCents) > tolerance) {
    return [{ category: cat, description: r.description || r.merchant || null, amount: totalCents / 100, onBehalfOf: null }];
  }
  lines.sort((a, b) => b.cents - a.cents);
  lines[0].cents += totalCents - sum;
  return lines.map(g => ({ category: g.category, description: g.names.join(', ').slice(0, 200) || null, amount: g.cents / 100, onBehalfOf: g.onBehalfOf }));
}

// Writes a read onto an expense. undefined leaves a field alone, so a value
// the reader could not make out never erases one already typed.
function applyRead(expenseId, r, extra = {}) {
  const patch = {
    merchant: r.merchant ?? undefined, receiptDate: r.date ?? undefined, receiptTime: r.time ?? undefined,
    invoiceNo: r.invoiceNumber ?? undefined, currency: r.currency ?? undefined,
    total: r.total ?? undefined, tax: r.tax ?? undefined, subTotal: r.subTotal ?? undefined,
    description: r.description ?? undefined, category: canonicalCategory(r.category) ?? undefined,
    aiConfidence: r.confidence || 'low', aiReadAt: new Date().toISOString(), ...extra,
  };
  const updated = store.updateExpense(expenseId, patch);
  if (!updated) return null;
  const lines = buildLines({ ...r, total: updated.total }, updated.category);
  if (lines.length) store.replaceLines(expenseId, lines.map(l => ({ ...l, currency: updated.currency })));
  return store.getExpense(expenseId);
}

// Same merchant, date and amount as another expense in the company: a note
// for a person, never an automatic 'duplicate'.
function flagIfSuspected(expenseId) {
  const exp = store.getExpense(expenseId);
  if (!exp || exp.status === 'duplicate' || !exp.merchant || !exp.receiptDate || !exp.total) return;
  const dup = findDuplicate({
    store: store.dedupView(exp.companyId), profile: { dedup: { byHash: false, byNumber: false, byFields: true } },
    vendorName: exp.merchant, date: exp.receiptDate, amount: exp.total, excludeId: expenseId,
  });
  if (!dup || !dup.match || !dup.match.id) return;
  store.updateExpense(expenseId, {
    duplicateOf: dup.match.id,
    errorMsg: `Possible duplicate of ${dup.match.invoiceNumber || dup.match.id} — ${dup.reason}. Check before submitting.`,
  });
}

function _sibling({ companyId, userId, receiptId, source, page = null, box = null }) {
  return store.createExpense({ companyId, userId, receiptId, source, page, box, status: 'reading' });
}

async function readReceipt({ companyId, userId, receiptId, expenseId, buffer, mime, source = 'upload' }) {
  const touched = [expenseId];
  let parsed = null;
  try {
    if (mime === 'application/pdf') {
      const extracted = await pdfPages.extractPages(buffer);
      store.updateReceipt(receiptId, { pages: extracted.numPages || null });

      if (!extracted.hasText) {
        const rendered = await pdfRender.renderPdfPages(buffer);
        if (!rendered || !rendered.pages.length) {
          store.updateExpense(expenseId, { errorMsg: 'This PDF could not be read automatically. Type the fields from the receipt.' });
        } else if (rendered.pages.length <= MAX_PAGES_ONE_DOC) {
          parsed = await parser.parseReceiptPages(userId, rendered.pages.map(p => ({ buffer: p.buffer, mime: 'image/jpeg' })));
          if (parsed) { applyRead(expenseId, parsed.receipts[0]); flagIfSuspected(expenseId); }
        } else {
          // A thick scan: one receipt per page, each read on its own.
          store.updateExpense(expenseId, { page: 1 });
          for (const p of rendered.pages) {
            const id = p.page === 1 ? expenseId : _sibling({ companyId, userId, receiptId, source, page: p.page }).id;
            if (p.page !== 1) touched.push(id);
            const one = await parser.parseReceiptImage(userId, p.buffer, 'image/jpeg');
            if (one) { applyRead(id, one.receipts[0]); flagIfSuspected(id); }
          }
        }
      } else {
        const decision = pdfPages.splittablePages(extracted);
        if (!decision.split) {
          parsed = await parser.parseReceiptText(userId, extracted.pages.join('\n\n'));
          if (parsed) { applyRead(expenseId, parsed.receipts[0]); flagIfSuspected(expenseId); }
        } else {
          const [first, ...rest] = decision.pageNumbers;
          store.updateExpense(expenseId, { page: first });
          const targets = [[expenseId, first]];
          for (const page of rest) { const sib = _sibling({ companyId, userId, receiptId, source, page }); touched.push(sib.id); targets.push([sib.id, page]); }
          for (const [id, page] of targets) {
            const one = await parser.parseReceiptText(userId, extracted.pages[page - 1]);
            if (one) { applyRead(id, one.receipts[0]); flagIfSuspected(id); }
          }
        }
      }
    } else {
      parsed = await parser.parseReceiptImage(userId, buffer, mime);
      if (parsed && !parsed.split) {
        applyRead(expenseId, parsed.receipts[0]); flagIfSuspected(expenseId);
      } else if (parsed) {
        const [first, ...rest] = parsed.receipts;
        applyRead(expenseId, first, { box: first.box || null }); flagIfSuspected(expenseId);
        for (const r of rest) {
          const sib = _sibling({ companyId, userId, receiptId, source, box: r.box || null });
          touched.push(sib.id);
          applyRead(sib.id, r); flagIfSuspected(sib.id);
        }
      }
    }
  } catch (err) {
    logger.warn('Receipt read failed', { userId, receiptId, error: err.message });
  } finally {
    // However it ended, the read is over: every row from this file leaves
    // 'reading', and the receipt is stamped so the phone can tell "read,
    // nothing found" from "still reading".
    const at = new Date().toISOString();
    for (const id of touched) {
      const e = store.getExpense(id);
      if (e && e.status === 'reading') store.updateExpense(id, { status: 'review-needed' });
    }
    store.updateReceipt(receiptId, { parsedAt: at, parseJson: parsed ? parsed.receipts : null });
  }
  return { expenseIds: touched };
}

// One document, read again onto ONE expense (no split): a photo goes back to
// the vision reader; a PDF to its text, or its rendered pages when it has none.
// Returns the normalised receipt or null.
async function readOne(userId, buffer, mime, { page = null, box = null } = {}) {
  if (mime !== 'application/pdf') {
    const out = await parser.parseReceiptImage(userId, buffer, mime);
    if (!out) return null;
    if (box && out.receipts.length > 1) {
      const centre = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      const [cy, cx] = centre(box);
      const withBox = out.receipts.filter(r => r.box);
      if (withBox.length) return withBox.reduce((best, r) => { const [ry, rx] = centre(r.box); const d = Math.hypot(ry - cy, rx - cx); return d < best.d ? { r, d } : best; }, { r: withBox[0], d: Infinity }).r;
    }
    return out.receipts[0];
  }
  const extracted = await pdfPages.extractPages(buffer);
  if (extracted.hasText) {
    const text = page ? extracted.pages[page - 1] : extracted.pages.join('\n\n');
    const out = await parser.parseReceiptText(userId, text);
    return out ? out.receipts[0] : null;
  }
  const rendered = await pdfRender.renderPdfPages(buffer);
  if (!rendered || !rendered.pages.length) return null;
  const pages = page ? rendered.pages.filter(p => p.page === page) : rendered.pages.slice(0, MAX_PAGES_ONE_DOC);
  const out = await parser.parseReceiptPages(userId, pages.map(p => ({ buffer: p.buffer, mime: 'image/jpeg' })));
  return out ? out.receipts[0] : null;
}

module.exports = { readReceipt, readOne, applyRead, buildLines, flagIfSuspected, MAX_PAGES_ONE_DOC };
```

- [ ] **Step 4: Run the tests**

Run: `npx jest main/receipts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(reader): one pipeline decides how a file is read and writes reconciled lines"
```

### Task 15: Receipts route (upload, phone pairing, images)

**Files:**
- Create: `main/routes/receipts.js`, `main/routes/receipts.test.js`

- [ ] **Step 1: Write the failing test**

`main/routes/receipts.test.js`:
```js
const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('../utils/receipt-parser', () => ({
  parseReceiptImage: jest.fn().mockResolvedValue(null), parseReceiptText: jest.fn().mockResolvedValue(null), parseReceiptPages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/pdf-render', () => ({ renderPdfPages: jest.fn().mockResolvedValue(null) }));

describe('routes/receipts', () => {
  let app, users, u, token, store, receiptStore, pairing, parser, routes;
  let _n = 0;
  const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ++_n]).toString('base64');

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users'); store = require('../store/expenses');
    receiptStore = require('../utils/receipt-store'); pairing = require('../utils/pairing'); pairing._reset();
    parser = require('../utils/receipt-parser'); parser.parseReceiptImage.mockReset(); parser.parseReceiptImage.mockResolvedValue(null);
    routes = require('./receipts');
    u = await users.createUser({ email: `r${Date.now()}@solv.sg`, password: 'password123' });
    token = jwt.sign({ id: u.id, email: u.email, role: u.role }, require('../middleware/auth-middleware').jwtSecret());
    app = express(); app.use(express.json({ limit: '25mb' })); app.use('/api/receipts', routes);
  });
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const upload = body => request(serverFor(app)).post('/api/receipts').set(auth()).send(body);

  test('requires authentication', async () => { await request(serverFor(app)).post('/api/receipts').send({ mime: 'image/jpeg', data: jpeg() }).expect(401); });

  test('stores the file, creates an expense in reading, then review-needed once read', async () => {
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Grab', date: '2026-09-01', total: 18.4, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }] });
    const res = await upload({ mime: 'image/jpeg', data: jpeg(), filename: 'grab.jpg' }).expect(201);
    expect(res.body.expense.status).toBe('reading');
    expect(res.body.receipt.file).toMatch(/\.jpg$/);
    expect(res.body.imageToken).toBeTruthy();
    expect(receiptStore.forUser(u.id).exists(res.body.receipt.file)).toBe(true);
    await routes._drain();
    const after = store.getExpense(res.body.expense.id);
    expect(after.status).toBe('review-needed');
    expect(after.merchant).toBe('Grab');
    expect(after.lines[0]).toMatchObject({ category: 'Air & Transport', amount: 18.4 });
  });

  test('the same bytes twice are refused with a pointer to the first', async () => {
    const data = jpeg();
    const first = await upload({ mime: 'image/jpeg', data }).expect(201);
    const dup = await upload({ mime: 'image/jpeg', data }).expect(409);
    expect(dup.body.duplicateOf).toBe(first.body.expense.id);
  });

  test('rejects an unsupported type, an oversized file, and bad base64 without creating rows', async () => {
    await upload({ mime: 'image/heic', data: jpeg() }).expect(400);
    await upload({ mime: 'image/jpeg', data: Buffer.alloc(receiptStore.MAX_BYTES + 10, 1).toString('base64') }).expect(413);
    await upload({ mime: 'image/jpeg', data: 'not base64 !!!' }).expect(400);
    expect(store.listExpenses({ userId: u.id })).toHaveLength(0);
  });

  test('the image is served to a scoped token and refused without one', async () => {
    const { body } = await upload({ mime: 'image/jpeg', data: jpeg() });
    await request(serverFor(app)).get(`/api/receipts/${body.receipt.id}/image?token=${body.imageToken}`).expect(200).expect('Content-Type', /image\/jpeg/);
    await request(serverFor(app)).get(`/api/receipts/${body.receipt.id}/image`).expect(401);
    const t = await request(serverFor(app)).get(`/api/receipts/${body.receipt.id}/token`).set(auth()).expect(200);
    expect(t.body.token).toBeTruthy();
  });

  test('phone pairing: mint, check, upload without login, poll from both sides, revoke', async () => {
    const pair = await request(serverFor(app)).post('/api/receipts/pair').set(auth()).expect(201);
    expect(pair.body.qrSvg).toMatch(/<svg/);
    await request(serverFor(app)).get(`/api/receipts/capture/${pair.body.token}`).expect(200);
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{ merchant: 'Gojek', total: 25, currency: 'SGD', category: 'Air & Transport', confidence: 'high', lineItems: [] }] });
    const up = await request(serverFor(app)).post(`/api/receipts/capture/${pair.body.token}`).send({ mime: 'image/jpeg', data: jpeg() }).expect(201);
    expect(up.body.imageToken).toBeUndefined();
    await routes._drain();
    const phone = await request(serverFor(app)).get(`/api/receipts/capture/${pair.body.token}/status`).expect(200);
    expect(phone.body.receipts[0]).toMatchObject({ parsed: true, merchant: 'Gojek', total: 25 });
    const desk = await request(serverFor(app)).get(`/api/receipts/pair/${pair.body.token}`).set(auth()).expect(200);
    expect(desk.body.receipts[0].merchant).toBe('Gojek');
    expect(desk.body.receipts[0].imageToken).toBeTruthy();
    await request(serverFor(app)).delete(`/api/receipts/pair/${pair.body.token}`).set(auth()).expect(200);
    await request(serverFor(app)).get(`/api/receipts/capture/${pair.body.token}`).expect(401);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest main/routes/receipts.test.js` → FAIL, cannot find module './receipts'.

- [ ] **Step 3: Write routes/receipts.js**

```js
const express      = require('express');
const router       = express.Router();
const jwt          = require('jsonwebtoken');
const QRCode       = require('qrcode');
const { newId }    = require('../utils/ids');
const { decodeBase64 } = require('../utils/base64');
const { hashBuffer }   = require('../intake/dedup');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const users        = require('../utils/users');
const store        = require('../store/expenses');
const receiptStore = require('../utils/receipt-store');
const thumbnailer  = require('../utils/thumbnailer');
const pairing      = require('../utils/pairing');
const { readReceipt } = require('../receipts/read-receipt');
const logger       = require('../utils/logger');

// A receipt FILE arrives here: dropped on the desktop or photographed on a
// paired phone. It is stored first, an expense row is created, and the read
// runs off the response path. Nothing here reaches Xero.

const IMAGE_TOKEN_TTL = '5m';
function issueImageToken(userId, receiptId) {
  return jwt.sign({ userId, receiptId, purpose: 'receipt' }, jwtSecret(), { expiresIn: IMAGE_TOKEN_TTL });
}
function verifyImageToken(token, receiptId) {
  const payload = jwt.verify(token, jwtSecret());
  if (payload.purpose !== 'receipt' || payload.receiptId !== receiptId) throw new Error('Token scope mismatch');
  return payload;
}

// Reads still running, so a test can wait for them.
const _inflight = new Set();

function storeReceipt(user, { mime, data, filename, source }) {
  if (!receiptStore.isAcceptedMime(mime)) {
    return { status: 400, body: { error: `Unsupported file type${mime ? ` (${mime})` : ''}. Accepted: ${receiptStore.acceptedMimes().join(', ')}.` } };
  }
  const buffer = decodeBase64(data);
  if (!buffer) return { status: 400, body: { error: 'File data is missing or not valid base64' } };
  if (buffer.length > receiptStore.MAX_BYTES) {
    const mb = n => `${(n / 1024 / 1024).toFixed(1)}MB`;
    return { status: 413, body: { error: `The file is ${mb(buffer.length)}; the limit is ${mb(receiptStore.MAX_BYTES)}.` } };
  }

  const hash = hashBuffer(buffer);
  const existing = store.findReceiptByHash(user.companyId, hash);
  if (existing) {
    const owned = store.expensesForReceipt(existing.id)[0] || null;
    logger.info('Receipt already uploaded', { userId: user.id, receiptId: existing.id });
    return { status: 409, body: {
      error: owned && owned.userId !== user.id ? 'This receipt was already uploaded by a colleague.' : `You have already uploaded this receipt${owned && owned.merchant ? ` (${owned.merchant})` : ''}.`,
      duplicateOf: owned ? owned.id : null, receiptId: existing.id,
    } };
  }

  const receiptId = newId();
  const storedName = receiptStore.forUser(user.id).save(receiptId, buffer, mime);
  const src = source === 'phone' ? 'phone' : 'upload';
  const receipt = store.createReceipt({ id: receiptId, companyId: user.companyId, userId: user.id, file: storedName, mime, sizeBytes: buffer.length, sha256: hash, source: src, originalName: filename || null });
  const expense = store.createExpense({ companyId: user.companyId, userId: user.id, receiptId, source: src, status: 'reading', currency: users.getUserDefaults(user.id).currency });
  logger.info('Receipt stored', { userId: user.id, receiptId, bytes: buffer.length, mime, source: src });

  const done = new Promise(resolve => setImmediate(() => {
    readReceipt({ companyId: user.companyId, userId: user.id, receiptId, expenseId: expense.id, buffer, mime, source: src })
      .catch(err => logger.warn('Receipt read failed', { userId: user.id, receiptId, error: err.message }))
      .finally(resolve);
  }));
  _inflight.add(done);
  done.finally(() => _inflight.delete(done));

  return { status: 201, body: { receipt, expense, imageToken: issueImageToken(user.id, receiptId) } };
}

router.post('/', requireAuth, (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const { status, body } = storeReceipt(me, req.body || {});
    res.status(status).json(body);
  } catch (err) {
    logger.error('Receipt upload failed', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// ── Phone pairing ───────────────────────────────────────────────────────────
function captureUrl(req, token) { return `${req.protocol}://${req.get('host')}/capture/${token}`; }

router.post('/pair', requireAuth, async (req, res) => {
  try {
    const token = pairing.create(req.user.id);
    const url   = captureUrl(req, token);
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' });
    res.status(201).json({ token, url, qrSvg, expiresInMs: pairing.TTL_MS, maxUploads: pairing.MAX_USES });
  } catch (err) {
    res.status(500).json({ error: 'Could not create a pairing code' });
  }
});

function _phoneView(receiptIds, withToken, userId) {
  return receiptIds.map(id => {
    const r = store.getReceipt(id);
    if (!r) return null;
    const e = store.expensesForReceipt(id)[0] || null;
    return {
      id, expenseId: e ? e.id : null, merchant: e ? e.merchant : null, total: e ? e.total : null, currency: e ? e.currency : null,
      parsed: !!r.parsedAt, unreadable: !!r.parsedAt && !(e && (e.merchant || e.total)),
      ...(withToken ? { imageToken: issueImageToken(userId, id) } : {}),
    };
  }).filter(Boolean);
}

router.get('/pair/:token', requireAuth, (req, res) => {
  if (!pairing.ownedBy(req.params.token, req.user.id)) return res.status(404).json({ error: 'Pairing not found' });
  const state = pairing.status(req.params.token);
  if (!state) return res.json({ alive: false, spent: false, uploads: 0, receipts: [] });
  res.json({ alive: state.alive, spent: state.spent, uploads: state.uses, usesLeft: state.usesLeft, expiresInMs: state.expiresInMs,
             receipts: _phoneView(state.receiptIds, true, req.user.id) });
});

router.delete('/pair/:token', requireAuth, (req, res) => {
  if (!pairing.ownedBy(req.params.token, req.user.id)) return res.status(404).json({ error: 'Pairing not found' });
  pairing.revoke(req.params.token);
  res.json({ ok: true });
});

const EXPIRED = { error: 'This link has expired. Show a new QR code on your computer.' };
router.get('/capture/:token', (req, res) => {
  const state = pairing.verify(req.params.token);
  if (!state) return res.status(401).json({ ok: false, ...EXPIRED });
  res.json({ ok: true, usesLeft: state.usesLeft, expiresInMs: state.expiresInMs });
});
router.get('/capture/:token/status', (req, res) => {
  const state = pairing.verify(req.params.token);
  if (!state) return res.status(401).json(EXPIRED);
  res.json({ ok: true, usesLeft: state.usesLeft, expiresInMs: state.expiresInMs, receipts: _phoneView(state.receiptIds, false) });
});
router.post('/capture/:token', (req, res) => {
  const state = pairing.verify(req.params.token);
  if (!state) return res.status(401).json(EXPIRED);
  try {
    const me = users.findById(state.userId);
    if (!me) return res.status(401).json(EXPIRED);
    const { status, body } = storeReceipt(me, { ...(req.body || {}), source: 'phone' });
    if (status === 201) pairing.consume(req.params.token, body.receipt.id);
    if (body.imageToken) delete body.imageToken;
    res.status(status).json(body);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// ── Images ──────────────────────────────────────────────────────────────────
router.get('/:id/token', requireAuth, (req, res) => {
  const r = store.getReceipt(req.params.id);
  const me = users.findById(req.user.id);
  if (!r || r.companyId !== me.companyId) return res.status(404).json({ error: 'Receipt not found' });
  res.json({ token: issueImageToken(r.userId, r.id) });
});

router.get('/:id/image', asyncHandler(async (req, res) => {
  let payload;
  try { payload = verifyImageToken(req.query.token, req.params.id); }
  catch { return res.status(401).json({ error: 'Invalid or expired image token' }); }
  const r = store.getReceipt(req.params.id);
  if (!r) return res.status(404).json({ error: 'Receipt not found' });
  const files = receiptStore.forUser(payload.userId);
  const filePath = files.getPath(r.file);
  if (!filePath) return res.status(404).json({ error: 'Receipt file is missing' });
  if (req.query.w) {
    const thumb = await thumbnailer.thumbnailPath(filePath, files.dir, r.file, req.query.w, r.mime);
    if (thumb) { res.type('image/jpeg'); res.setHeader('Cache-Control', 'private, max-age=86400'); return res.sendFile(thumb); }
  }
  res.type(r.mime || 'application/octet-stream');
  res.sendFile(filePath);
}));

module.exports = router;
module.exports.storeReceipt = storeReceipt;
module.exports.issueImageToken = issueImageToken;
module.exports._drain = async function _drain() { while (_inflight.size) await Promise.allSettled([..._inflight]); };
```

- [ ] **Step 4: Run the tests**

Run: `npx jest main/routes/receipts.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(receipts): upload, phone pairing and scoped image serving on the expense store"
```

### Task 16: Expenses route

**Files:**
- Create: `main/routes/expenses.js`, `main/routes/expenses.test.js`

- [ ] **Step 1: Write the failing test**

`main/routes/expenses.test.js`:
```js
const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('../receipts/read-receipt', () => ({ readOne: jest.fn(), applyRead: jest.requireActual('../receipts/read-receipt').applyRead, flagIfSuspected: jest.fn() }));

describe('routes/expenses', () => {
  let app, users, store, admin, emp, mgr, fin, tokens, read;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users'); store = require('../store/expenses'); read = require('../receipts/read-receipt');
    read.readOne.mockReset();
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    mgr = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: admin.companyId, role: 'manager' });
    fin = await users.createUser({ email: 'f@solv.sg', password: 'password123', companyId: admin.companyId, role: 'finance' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, managerId: mgr.id });
    const secret = require('../middleware/auth-middleware').jwtSecret();
    tokens = Object.fromEntries([admin, mgr, fin, emp].map(u => [u.email, jwt.sign({ id: u.id, email: u.email, role: u.role }, secret)]));
    app = express(); app.use(express.json()); app.use('/api/expenses', require('./expenses'));
  });
  const as = u => ({ Authorization: `Bearer ${tokens[u.email]}` });
  const seed = (owner, extra = {}) => {
    const r = store.createReceipt({ companyId: owner.companyId, userId: owner.id, file: 'r.jpg', mime: 'image/jpeg', sha256: `h${Math.random()}` });
    return store.createExpense({ companyId: owner.companyId, userId: owner.id, receiptId: r.id, status: 'review-needed', merchant: 'Courtyard', currency: 'INR', total: 100, receiptDate: '2026-09-04',
      lines: [{ category: 'Lodging', amount: 100 }], ...extra });
  };

  test('an employee lists and reads only their own; a manager sees a direct report; finance sees all', async () => {
    const mine = seed(emp); const theirs = seed(admin);
    const list = await request(serverFor(app)).get('/api/expenses').set(as(emp)).expect(200);
    expect(list.body.expenses.map(e => e.id)).toEqual([mine.id]);
    await request(serverFor(app)).get(`/api/expenses/${theirs.id}`).set(as(emp)).expect(404);
    await request(serverFor(app)).get(`/api/expenses/${mine.id}`).set(as(mgr)).expect(200);
    await request(serverFor(app)).get(`/api/expenses/${theirs.id}`).set(as(mgr)).expect(404);
    const all = await request(serverFor(app)).get('/api/expenses?all=1').set(as(fin)).expect(200);
    expect(all.body.expenses).toHaveLength(2);
    const detail = await request(serverFor(app)).get(`/api/expenses/${mine.id}`).set(as(emp)).expect(200);
    expect(detail.body.expense.lines).toHaveLength(1);
    expect(detail.body.imageToken).toBeTruthy();
  });

  test('editing fields; a new total resizes a single line; a bad currency is refused', async () => {
    const e = seed(emp);
    const r = await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ purpose: 'Client site visit', total: 120.5, merchant: 'Courtyard Pune' }).expect(200);
    expect(r.body.expense.purpose).toBe('Client site visit');
    expect(r.body.expense.lines[0].amount).toBe(120.5);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ currency: 'rupees' }).expect(400);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(admin)).send({ purpose: 'x' }).expect(200);   // admin may edit
  });

  test('lines must reconcile; a good split is stored with on-behalf', async () => {
    const e = seed(emp);
    await request(serverFor(app)).put(`/api/expenses/${e.id}/lines`).set(as(emp)).send({ lines: [{ category: 'Lodging', amount: 60 }, { category: 'Meals', amount: 30 }] }).expect(400);
    const ok = await request(serverFor(app)).put(`/api/expenses/${e.id}/lines`).set(as(emp))
      .send({ lines: [{ category: 'Lodging', amount: 60, onBehalfOf: 'Tan Suan Kuan' }, { category: 'Meals', amount: 40 }] }).expect(200);
    expect(ok.body.expense.lines.map(l => l.amount)).toEqual([60, 40]);
    expect(ok.body.expense.lines[0].onBehalfOf).toBe('Tan Suan Kuan');
  });

  test('marking reviewed needs a merchant, date, currency, total and reconciled lines', async () => {
    const e = seed(emp, { merchant: null });
    const bad = await request(serverFor(app)).patch(`/api/expenses/${e.id}/status`).set(as(emp)).send({ status: 'reviewed' }).expect(400);
    expect(bad.body.error).toMatch(/merchant/i);
    await request(serverFor(app)).patch(`/api/expenses/${e.id}`).set(as(emp)).send({ merchant: 'Courtyard' }).expect(200);
    const ok = await request(serverFor(app)).patch(`/api/expenses/${e.id}/status`).set(as(emp)).send({ status: 'reviewed' }).expect(200);
    expect(ok.body.expense.status).toBe('reviewed');
    await request(serverFor(app)).patch(`/api/expenses/${e.id}/status`).set(as(emp)).send({ status: 'posted' }).expect(400);
  });

  test('re-read applies the reader result to this expense only', async () => {
    const e = seed(emp);
    read.readOne.mockResolvedValue({ merchant: 'JW Marriott', date: '2026-09-01', currency: 'INR', total: 44309, category: 'Lodging', confidence: 'high', lineItems: [] });
    const r = await request(serverFor(app)).post(`/api/expenses/${e.id}/reread`).set(as(emp)).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.expense.merchant).toBe('JW Marriott');
    expect(r.body.expense.lines).toEqual([expect.objectContaining({ amount: 44309 })]);
    read.readOne.mockResolvedValue(null);
    const miss = await request(serverFor(app)).post(`/api/expenses/${e.id}/reread`).set(as(emp)).expect(200);
    expect(miss.body.ok).toBe(false);
  });

  test('group lists siblings from one file and merge collapses them', async () => {
    const r = store.createReceipt({ companyId: emp.companyId, userId: emp.id, file: 'two.jpg', mime: 'image/jpeg', sha256: 'two' });
    const a = store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: r.id, status: 'review-needed', merchant: 'A', total: 5, box: [0, 0, 500, 1000] });
    const b = store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: r.id, status: 'review-needed', merchant: 'B', total: 7, box: [500, 0, 1000, 1000] });
    const g = await request(serverFor(app)).get(`/api/expenses/${a.id}/group`).set(as(emp)).expect(200);
    expect(g.body.total).toBe(2);
    expect(g.body.siblings.map(s => s.id).sort()).toEqual([a.id, b.id].sort());
    await request(serverFor(app)).post(`/api/expenses/${a.id}/merge`).set(as(emp)).expect(200);
    expect(store.getExpense(b.id)).toBeNull();
    expect(store.getExpense(a.id).box).toBeNull();
  });

  test('delete removes the expense and the file once nothing references it', async () => {
    const receiptStore = require('../utils/receipt-store');
    const files = receiptStore.forUser(emp.id);
    const name = files.save('del1', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
    const r = store.createReceipt({ id: 'del1', companyId: emp.companyId, userId: emp.id, file: name, mime: 'image/jpeg', sha256: 'del' });
    const e = store.createExpense({ companyId: emp.companyId, userId: emp.id, receiptId: r.id, status: 'review-needed', total: 1 });
    await request(serverFor(app)).delete(`/api/expenses/${e.id}`).set(as(admin)).expect(200);
    expect(store.getExpense(e.id)).toBeNull();
    expect(files.exists(name)).toBe(false);
    expect(store.getReceipt(r.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail** — `npx jest main/routes/expenses.test.js` → FAIL, module not found.

- [ ] **Step 3: Write routes/expenses.js**

```js
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { canAccessUser } = require('../middleware/roles');
const users   = require('../utils/users');
const store   = require('../store/expenses');
const receiptStore = require('../utils/receipt-store');
const { issueImageToken } = require('./receipts');
const { readOne, applyRead, flagIfSuspected } = require('../receipts/read-receipt');
const { canonicalCategory } = require('../claims/categories');
const logger  = require('../utils/logger');

// An expense is one claimable receipt after reading. Employees work on their
// own; a manager sees direct reports; finance and admin see the company.
const EDITABLE = ['merchant', 'receiptDate', 'receiptTime', 'invoiceNo', 'currency', 'total', 'tax', 'subTotal', 'purpose', 'description', 'category', 'reportId'];

function _load(req, res) {
  const e = store.getExpense(req.params.id);
  if (!e || !canAccessUser(req.user, e.userId)) { res.status(404).json({ error: 'Expense not found' }); return null; }
  return e;
}
function _out(e) { return { expense: e, imageToken: e.receipt ? issueImageToken(e.receipt.userId, e.receipt.id) : null }; }

router.get('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  const wide = req.query.all === '1' && (req.user.role === 'finance' || req.user.role === 'admin');
  const filter = { status: req.query.status || undefined, reportId: req.query.reportId || undefined, unfiled: req.query.unfiled === '1',
                   from: req.query.from || undefined, to: req.query.to || undefined };
  let list;
  if (wide) list = store.listExpenses({ companyId: me.companyId, userId: req.query.userId || undefined, ...filter });
  else if (req.query.userId && req.query.userId !== req.user.id) {
    if (!canAccessUser(req.user, req.query.userId)) return res.status(403).json({ error: 'Not your report' });
    list = store.listExpenses({ userId: req.query.userId, ...filter });
  } else list = store.listExpenses({ userId: req.user.id, ...filter });
  res.json({ expenses: list });
});

router.get('/:id', requireAuth, (req, res) => { const e = _load(req, res); if (e) res.json(_out(e)); });

router.patch('/:id', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  if (['duplicate'].includes(e.status)) return res.status(400).json({ error: 'A duplicate cannot be edited; delete it or restore it first' });
  const b = req.body || {}, patch = {};
  for (const k of EDITABLE) if (b[k] !== undefined) patch[k] = b[k] === '' ? null : b[k];
  if (patch.currency && !/^[A-Z]{3}$/.test(String(patch.currency))) return res.status(400).json({ error: 'Currency must be a 3-letter code like SGD or INR' });
  if (patch.receiptDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(patch.receiptDate))) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  for (const k of ['total', 'tax', 'subTotal']) if (patch[k] !== undefined && patch[k] !== null && !(Number(patch[k]) >= 0)) return res.status(400).json({ error: `${k} must be a number` });
  if (patch.category !== undefined && patch.category !== null && !canonicalCategory(patch.category)) return res.status(400).json({ error: 'Unknown category' });
  if (patch.category) patch.category = canonicalCategory(patch.category);
  const updated = store.updateExpense(e.id, patch);
  // A single line follows the total; a split is the claimant's to redo.
  if (patch.total !== undefined && updated.lines.length === 1) {
    store.replaceLines(e.id, [{ ...updated.lines[0], amount: updated.total, currency: updated.currency }]);
  } else if (patch.currency && updated.lines.length) {
    store.replaceLines(e.id, updated.lines.map(l => ({ ...l, currency: updated.currency })), { force: true });
  }
  res.json(_out(store.getExpense(e.id)));
});

router.put('/:id/lines', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  const lines = Array.isArray((req.body || {}).lines) ? req.body.lines : null;
  if (!lines || !lines.length) return res.status(400).json({ error: 'Send at least one line' });
  for (const l of lines) {
    if (!(Number(l.amount) > 0)) return res.status(400).json({ error: 'Every line needs an amount above zero' });
    if (l.category && !canonicalCategory(l.category)) return res.status(400).json({ error: `Unknown category "${l.category}"` });
  }
  try {
    store.replaceLines(e.id, lines.map(l => ({ category: canonicalCategory(l.category) || e.category || 'Other', description: l.description || null, amount: Number(l.amount), onBehalfOf: l.onBehalfOf || null, currency: e.currency })));
  } catch (err) { return res.status(400).json({ error: err.message }); }
  res.json(_out(store.getExpense(e.id)));
});

router.patch('/:id/status', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  const status = (req.body || {}).status;
  if (!['reviewed', 'review-needed'].includes(status)) return res.status(400).json({ error: 'Status can be reviewed or review-needed here' });
  if (status === 'reviewed') {
    const missing = [];
    if (!e.merchant) missing.push('merchant');
    if (!e.receiptDate) missing.push('date');
    if (!e.currency) missing.push('currency');
    if (!(e.total > 0)) missing.push('total');
    if (missing.length) return res.status(400).json({ error: `Fill in the ${missing.join(', ')} before marking this reviewed` });
    if (!store.linesReconcile(e.lines, store.toCents(e.total))) return res.status(400).json({ error: 'The lines do not add up to the receipt total' });
  }
  res.json(_out(store.updateExpense(e.id, { status })));
});

router.post('/:id/reread', requireAuth, async (req, res) => {
  const e = _load(req, res); if (!e) return;
  if (!e.receipt) return res.status(400).json({ error: 'This expense has no receipt file to read' });
  const buffer = receiptStore.forUser(e.receipt.userId).read(e.receipt.file);
  if (!buffer) return res.status(404).json({ error: 'The receipt file is missing from storage' });
  try {
    const r = await readOne(e.userId, buffer, e.receipt.mime, { page: e.page, box: e.box });
    if (!r) return res.json({ ok: false, reason: 'unreadable', expense: e });
    applyRead(e.id, r); flagIfSuspected(e.id);
    res.json({ ok: true, ...(_out(store.getExpense(e.id))), confidence: r.confidence });
  } catch (err) {
    logger.warn('Re-read failed', { id: e.id, error: err.message });
    res.json({ ok: false, reason: 'unavailable', expense: e });
  }
});

router.get('/:id/group', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  if (!e.receiptId) return res.json({ split: false, index: 1, total: 1, siblings: [] });
  const members = store.expensesForReceipt(e.receiptId).sort((a, b) => (a.page || 0) - (b.page || 0) || String(a.id).localeCompare(String(b.id)));
  const groupId = e.receipt && e.receipt.groupId;
  const batch = groupId ? store.listExpenses({ groupId }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) : null;
  const list = batch && batch.length > 1 ? batch : members;
  res.json({
    split: list.length > 1, groupType: batch && batch.length > 1 ? 'batch' : 'split',
    index: list.findIndex(x => x.id === e.id) + 1, total: list.length,
    siblings: list.map(x => ({ id: x.id, merchant: x.merchant, total: x.total, currency: x.currency, page: x.page, status: x.status })),
  });
});

router.post('/:id/merge', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  if (!e.receiptId) return res.status(400).json({ error: 'This expense was not split' });
  const siblings = store.expensesForReceipt(e.receiptId).filter(x => x.id !== e.id);
  if (!siblings.length) return res.status(400).json({ error: 'This expense was not split' });
  for (const s of siblings) store.deleteExpense(s.id);
  res.json(_out(store.updateExpense(e.id, { box: null, page: null })));
});

router.delete('/:id', requireAuth, (req, res) => {
  const e = _load(req, res); if (!e) return;
  store.deleteExpense(e.id);
  if (e.receipt && store.countExpensesForReceipt(e.receipt.id) === 0) {
    if (store.countExpensesForFile(e.receipt.userId, e.receipt.file) === 0) receiptStore.forUser(e.receipt.userId).remove(e.receipt.file);
    store.deleteReceipt(e.receipt.id);
  }
  logger.info('Expense deleted', { id: e.id, by: req.user.email });
  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 4: Run** — `npx jest main/routes/expenses.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(expenses): list, edit, split lines, review, re-read, group, merge, delete with role access"
```

### Task 17: Batch import (ZIP + claim form)

**Files:**
- Create (copied): `main/claims/{claim-archive,claim-form,claim-matcher,claim-import,claim-categories}.js` and tests
- Create: `main/claims/claim-record.js` (rewritten), `main/routes/claims.js`, `main/routes/claims.test.js`

- [ ] **Step 1: Copy the unchanged modules**

```bash
for f in claim-archive claim-form claim-matcher claim-import claim-categories; do cp "$XERO/main/claims/$f.js" main/claims/; done
for f in claim-archive claim-form claim-matcher claim-import; do cp "$XERO/main/claims/$f.test.js" main/claims/; done
mv main/claims/claim-categories.test.js.later main/claims/claim-categories.test.js
```
Run: `npx jest main/claims` → PASS (these tests inject their dependencies).

- [ ] **Step 2: Write claim-record.js for the expense store**

```js
const { hashBuffer, findDuplicate } = require('../intake/dedup');
const { canonicalCategory } = require('./categories');
const users  = require('../utils/users');
const store  = require('../store/expenses');
const logger = require('../utils/logger');

// One matched claim line (a form row, a receipt, or both) becomes a receipt
// row and an expense with one line. Injected into the import job.
async function createClaimRecord({ userId, groupId, row, receipt, match, category, store: storeFile }) {
  const me = users.findById(userId);
  const companyId = me.companyId;
  const hash = receipt && receipt.buffer ? hashBuffer(receipt.buffer) : null;
  const dup = findDuplicate({
    store: store.dedupView(companyId), profile: { dedup: { byHash: true, byNumber: false, byFields: true } }, hash,
    vendorName: (receipt && receipt.merchant) || null,
    date: row.date ?? (receipt && receipt.date) ?? null, amount: row.amount ?? (receipt && receipt.total) ?? null,
  });

  let receiptId = null;
  if (dup && dup.certain && dup.match.receiptId) {
    receiptId = dup.match.receiptId;                     // same bytes: point at the stored file
  } else if (receipt && receipt.buffer) {
    try {
      const rec = store.createReceipt({ companyId, userId, file: 'pending', mime: receipt.mime, sizeBytes: receipt.buffer.length, sha256: hash, source: 'import', groupId, originalName: receipt.file || null });
      const name = await storeFile(userId, rec.id, receipt.buffer, receipt.mime);
      require('../db').prepare('UPDATE receipts SET file = ?, parsed_at = ? WHERE id = ?').run(name, new Date().toISOString(), rec.id);
      receiptId = rec.id;
    } catch (err) {
      logger.warn('Claim receipt could not be stored', { userId, error: err.message });
    }
  }

  const ref = dup ? (dup.match.invoiceNumber || dup.match.id) : null;
  const note = dup && !dup.certain ? `Possible duplicate of ${ref} — ${dup.reason}. Check before submitting.`
    : dup ? `Duplicate of ${ref} — ${dup.reason}`
    : match && match.discrepancy ? `Claimed ${match.discrepancy.claimed} but the receipt says ${match.discrepancy.onReceipt}`
    : (!receipt && row.no ? 'No receipt found for this claim line' : null);

  const cat = canonicalCategory(category) || canonicalCategory(receipt && receipt.category) || null;
  const total = row.amount != null ? row.amount : (receipt && receipt.total != null ? receipt.total : 0);
  const currency = row.currency || (receipt && receipt.currency) || users.getUserDefaults(userId).currency;
  const description = row.description || (receipt && receipt.description) || (receipt && receipt.merchant) || null;

  return store.createExpense({
    companyId, userId, receiptId, source: 'import',
    merchant: (receipt && receipt.merchant) || null, receiptDate: row.date || (receipt && receipt.date) || null, receiptTime: receipt && receipt.time || null,
    invoiceNo: receipt && receipt.invoiceNumber || null, currency, total, tax: receipt && receipt.tax != null ? receipt.tax : null,
    subTotal: receipt && receipt.subTotal != null ? receipt.subTotal : null, description, category: cat,
    status: dup && dup.certain ? 'duplicate' : 'review-needed', duplicateOf: dup && dup.match.id ? dup.match.id : null, errorMsg: note,
    aiReadAt: receipt && receipt.readable !== false ? new Date().toISOString() : null, aiConfidence: receipt && receipt.confidence || null,
    lines: total > 0 ? [{ category: cat || 'Other', description, amount: total, currency }] : [],
  });
}

module.exports = { createClaimRecord };
```

- [ ] **Step 3: Write routes/claims.js**

```js
const express      = require('express');
const router       = express.Router();
const { decodeBase64 } = require('../utils/base64');
const { requireAuth } = require('../middleware/auth-middleware');
const users        = require('../utils/users');
const store        = require('../store/expenses');
const receiptStore = require('../utils/receipt-store');
const claimImport  = require('../claims/claim-import');
const claimQueue   = require('../claims/claim-queue');
const claimWorker  = require('../claims/claim-worker');
const { parseReceiptBatch } = require('../utils/receipt-parser');
const { readOne }  = require('../receipts/read-receipt');
const { suggestCategories } = require('../claims/claim-categories');
const { createClaimRecord } = require('../claims/claim-record');
const logger       = require('../utils/logger');

// A batch claim: a zip of receipts plus the claim-form spreadsheet, as they
// arrive by email. Runs as a background job; the client polls.
const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;

// Images are read five to a call; a PDF in the archive goes through the same
// classify-and-read the upload path uses (text, or rendered pages).
async function parseEntries(userId, entries) {
  const out = new Array(entries.length).fill(null);
  const imageIdx = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].mime === 'application/pdf') { try { out[i] = await readOne(userId, entries[i].buffer, entries[i].mime); } catch { out[i] = null; } }
    else imageIdx.push(i);
  }
  if (imageIdx.length) {
    const read = await parseReceiptBatch(userId, imageIdx.map(i => ({ buffer: entries[i].buffer, mime: entries[i].mime })));
    imageIdx.forEach((i, k) => { out[i] = read[k]; });
  }
  return out;
}

function deps() {
  return {
    parseReceipts: parseEntries,
    storeReceipt: (uid, id, buffer, mime) => receiptStore.forUser(uid).save(id, buffer, mime),
    createRecord: createClaimRecord,
    suggest: (uid, matches, categories) => suggestCategories(uid, matches, categories),
  };
}
claimWorker.registerJobType('claim-import', {
  defaultDeps: () => deps(),
  run: ({ userId, job, payload, deps: d }) => claimImport.startImport({ userId, archives: payload.archives, forms: payload.forms, label: job.label, id: job.id }, d),
});

router.post('/import', requireAuth, (req, res) => {
  try {
    const { archives = [], forms = [], label } = req.body || {};
    if (!Array.isArray(archives) || !Array.isArray(forms) || (!archives.length && !forms.length)) return res.status(400).json({ error: 'Attach at least a claim archive or a claim form' });
    const decode = list => {
      const out = [];
      for (const f of list) {
        const name = (f && f.name) || 'a file';
        if (typeof (f && f.data) !== 'string' || !f.data) return { error: `${name} came through empty. Open it once so it downloads, then try again.` };
        const buffer = decodeBase64(f.data);
        if (!buffer) return { error: `${name} arrived damaged and could not be decoded.` };
        out.push({ name: f.name || 'file', buffer });
      }
      return { out };
    };
    const a = decode(archives); if (a.error) return res.status(400).json({ error: a.error });
    const f = decode(forms);    if (f.error) return res.status(400).json({ error: f.error });
    const bytes = [...a.out, ...f.out].reduce((s, x) => s + x.buffer.length, 0);
    if (bytes > MAX_UPLOAD_BYTES) return res.status(413).json({ error: `That is ${(bytes / 1048576).toFixed(1)}MB; the limit is ${MAX_UPLOAD_BYTES / 1048576}MB.` });

    const enq = claimQueue.enqueue(req.user.id, { archives: a.out, forms: f.out, label: label || 'Expense claim' });
    if (enq.error) return res.status(429).json({ error: enq.error });
    claimWorker.startWorker(req.user.id, deps());
    claimWorker.kickWorker(req.user.id);
    logger.info('Claim import enqueued', { userId: req.user.id, jobId: enq.job.id });
    res.status(202).json({ jobId: enq.job.id, stage: enq.job.stage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const view = j => ({ id: j.id, label: j.label, stage: j.stage, receiptsTotal: j.receiptsTotal, receiptsRead: j.receiptsRead, rowsTotal: j.rowsTotal, error: j.error, result: j.result,
                     startedAt: j.startedAt ? new Date(j.startedAt).toISOString() : (j.createdAt || null) });

router.get('/active', requireAuth, (req, res) => {
  const mem = claimImport.listJobs(req.user.id).find(j => !['done', 'failed', 'cancelled'].includes(j.stage));
  if (mem) return res.json({ job: view(mem) });
  const disk = claimQueue.getPending(req.user.id)[0];
  res.json({ job: disk ? view(disk) : null });
});

router.get('/import/:jobId', requireAuth, (req, res) => {
  const job = claimImport.getJob(req.params.jobId, req.user.id) || claimQueue.get(req.user.id, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Import not found — it may have expired' });
  res.json(view(job));
});

router.delete('/import/:jobId', requireAuth, (req, res) => {
  const mem = claimImport.cancel(req.params.jobId, req.user.id);
  const disk = claimQueue.markCancelled(req.user.id, req.params.jobId);
  if (!mem && !disk) return res.status(404).json({ error: 'Import not found' });
  res.json({ stage: (mem && mem.stage) || (disk && disk.stage) || 'cancelled' });
});

// Undo a whole import: every expense from it, and every file nothing else uses.
router.delete('/group/:groupId', requireAuth, (req, res) => {
  const members = store.listExpenses({ groupId: req.params.groupId, userId: req.user.id });
  if (!members.length) return res.status(404).json({ error: 'Nothing found for that import' });
  let files = 0;
  for (const e of members) {
    store.deleteExpense(e.id);
    if (e.receipt && store.countExpensesForReceipt(e.receipt.id) === 0) {
      if (store.countExpensesForFile(e.receipt.userId, e.receipt.file) === 0 && receiptStore.forUser(e.receipt.userId).remove(e.receipt.file)) files++;
      store.deleteReceipt(e.receipt.id);
    }
  }
  logger.info('Claim import undone', { userId: req.user.id, groupId: req.params.groupId, removed: members.length, files });
  res.json({ removed: members.length });
});

module.exports = router;
```

- [ ] **Step 4: Port the route test and adapt it**

```bash
cp "$XERO/main/routes/claims.test.js" main/routes/claims.test.js
```
Adapt: replace `invoiceStore = require('../utils/invoice-store')` with `store = require('../store/expenses')`; create the user with `users.createUser({ email, password })` (the first user is admin and gets the company); anywhere the test reads `invoiceStore.forUser(id).getAll()` use `store.listExpenses({ userId: testUser.id })`; field names `vendorName → merchant`, `totalAmount → total`, `invoiceDate → receiptDate`, `receiptFile → receipt.file`, `receiptGroup → receipt.groupId`, `invoiceType` assertions removed. Add `parseReceiptPages: jest.fn().mockResolvedValue(null)` to the parser mock and `jest.mock('../utils/pdf-render', () => ({ renderPdfPages: jest.fn().mockResolvedValue(null) }))`. Drop tests that assert on `accountCode` or Xero. Keep every test about: 202 + polling, receipts-without-form create expenses, duplicates within one archive, the group undo, the 429 queue cap, and the size cap message (now 18MB).

Run: `npx jest main/routes/claims.test.js main/claims` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(import): ZIP + claim-form batch import creates expenses on the expense store"
```

## Phase 1 — UI

### Task 18: UI shell (entry, contexts, theme, layout, login)

**Files:**
- Create (copied): `ui/src/main.jsx`, `ui/src/api/client.js`, `ui/src/context/{AuthContext,ThemeContext,ViewModeContext}.jsx`, `ui/src/styles/globals.css`, `ui/src/utils/{format,formatDate,useVisiblePolling}.js`, `ui/src/components/{Modal,ConfirmDialog}.jsx`, `ui/src/components/layout/{Header,BottomNav}.jsx`, `ui/src/pages/Login.jsx`, `main/scripts/{ui-api-paths,lint}.test.js`
- Create: `ui/src/App.jsx`, `ui/src/styles/theme.css`, `ui/src/components/layout/{Layout,Sidebar}.jsx`, `ui/src/components/StatusBadge.jsx`

- [ ] **Step 1: Copy**

```bash
mkdir -p ui/src/{api,context,styles,utils,components/layout,components/receipts,pages}
cp "$XERO/ui/src/main.jsx" ui/src/main.jsx
cp "$XERO/ui/src/api/client.js" ui/src/api/client.js
for f in AuthContext ThemeContext ViewModeContext; do cp "$XERO/ui/src/context/$f.jsx" ui/src/context/; done
cp "$XERO/ui/src/styles/globals.css" ui/src/styles/globals.css
for f in format formatDate useVisiblePolling; do cp "$XERO/ui/src/utils/$f.js" ui/src/utils/; done
cp "$XERO/ui/src/components/Modal.jsx" "$XERO/ui/src/components/ConfirmDialog.jsx" ui/src/components/
cp "$XERO/ui/src/components/layout/Header.jsx" "$XERO/ui/src/components/layout/BottomNav.jsx" ui/src/components/layout/
cp "$XERO/ui/src/pages/Login.jsx" ui/src/pages/Login.jsx
cp "$XERO/main/scripts/ui-api-paths.test.js" "$XERO/main/scripts/lint.test.js" main/scripts/
```
Edits:
- `ui/src/context/ViewModeContext.jsx`: `STORAGE_KEY = 'solv_view_mode'`.
- `ui/src/context/ThemeContext.jsx`: default `'light'` instead of `'dark'`.
- `ui/src/context/AuthContext.jsx`: in `register`, keep the token the server returns: `const data = await api.post('/auth/register', { email, password, name }); localStorage.setItem('token', data.token); setUser(data.user); return data.user;` and give `register` a third `name` argument.
- `ui/src/components/layout/BottomNav.jsx`: remove the `usePipeline` import and the `isProcessing` dot; `NAV_ITEMS = [{ to: '/', label: 'Home', icon: '▦' }, { to: '/expenses', label: 'Expenses', icon: '◧' }, { to: '/settings', label: 'Settings', icon: '◈' }]` and use `end` on the Home `NavLink` (`<NavLink end={item.to === '/'} ...>`).
- `ui/src/components/layout/Header.jsx`: replace `getBreadcrumbs` with
  ```js
  function getBreadcrumbs(pathname) {
    if (pathname === '/')          return [{ label: 'Home' }];
    if (pathname === '/expenses')  return [{ label: 'My expenses' }];
    if (pathname.startsWith('/expenses/')) return [{ label: 'My expenses', to: '/expenses' }, { label: 'Review' }];
    if (pathname === '/settings')  return [{ label: 'Settings' }];
    return [];
  }
  ```
  and the left-hand label `App` → `Solv`.
- `ui/src/pages/Login.jsx`: brand text `Xero Automation` → `Solv Expenses`; the `⚡` glyph → `S`; the register placeholder `Min. 6 characters` → `Min. 8 characters` and `minLength={mode === 'register' ? 8 : 1}`; after a successful submit `navigate('/')`; the footer line → `Receipts stay on your company's server.`; the first-run note → `The first account becomes the administrator and creates the company.`
- `main/scripts/ui-api-paths.test.js`: it reads `pages/Capture.jsx` for the raw-fetch rule; that file arrives in Task 19, so this test runs green from then on.

- [ ] **Step 2: Write theme.css**

`ui/src/styles/theme.css`:
```css
/* Solv palette. Token names are the Xero app's so ported components drop in. */
:root, [data-theme="light"] {
  --bg-primary: #F6F5F1;  --bg-secondary: #EEF0EA;  --bg-sidebar: #FFFFFF;  --bg-card: #FFFFFF;  --bg-input: #F3F4EF;  --bg-hover: #E9ECE5;  --bg-glass: rgba(255,255,255,0.84);
  --text-primary: #17262B;  --text-secondary: #4B5A5F;  --text-muted: #7A878B;  --text-sidebar: #4B5A5F;  --text-sidebar-active: #0F6E56;
  --border: #D8DBD4;  --border-focus: #0F6E56;  --border-card: rgba(15,110,86,0.12);  --border-sidebar: #D8DBD4;
  --accent: #0F6E56;  --accent-hover: #0B5341;  --accent-text: #FFFFFF;  --accent-subtle: rgba(15,110,86,0.10);  --accent-gradient: linear-gradient(135deg, #0F6E56 0%, #1C8F73 100%);
  --success: #0F6E56;  --success-subtle: rgba(15,110,86,0.12);  --warning: #B7791F;  --warning-subtle: rgba(183,121,31,0.12);  --danger: #B42318;  --danger-subtle: rgba(180,35,24,0.10);  --info: #2F6F9F;  --info-subtle: rgba(47,111,159,0.10);
  --shadow-xs: 0 1px 3px rgba(23,38,43,0.06);  --shadow-sm: 0 2px 10px rgba(23,38,43,0.07), 0 1px 3px rgba(0,0,0,0.04);  --shadow-md: 0 8px 28px rgba(23,38,43,0.10), 0 2px 8px rgba(0,0,0,0.04);  --shadow-lg: 0 20px 60px rgba(23,38,43,0.16), 0 4px 16px rgba(0,0,0,0.06);  --glow-accent: 0 0 0 3px rgba(15,110,86,0.18);
  --radius-xs: 4px;  --radius-sm: 8px;  --radius-md: 12px;  --radius-lg: 16px;  --radius-xl: 22px;
  --sidebar-width: 236px;  --header-height: 58px;
  --transition-fast: 0.12s ease;  --transition: 0.2s ease;  --transition-slow: 0.35s cubic-bezier(0.4,0,0.2,1);
}
[data-theme="dark"] {
  --bg-primary: #0F1514;  --bg-secondary: #161D1B;  --bg-sidebar: #0C1211;  --bg-card: #161D1B;  --bg-input: #1C2523;  --bg-hover: #212B28;  --bg-glass: rgba(22,29,27,0.82);
  --text-primary: #E6EBE8;  --text-secondary: #A2ACA7;  --text-muted: #6F7B77;  --text-sidebar: rgba(255,255,255,0.55);  --text-sidebar-active: #FFFFFF;
  --border: #27312E;  --border-focus: #3EB38C;  --border-card: rgba(255,255,255,0.05);  --border-sidebar: #27312E;
  --accent: #3EB38C;  --accent-hover: #6FD1AE;  --accent-text: #0F1514;  --accent-subtle: rgba(62,179,140,0.14);  --accent-gradient: linear-gradient(135deg, #2E9B78 0%, #3EB38C 100%);
  --success: #3EB38C;  --success-subtle: rgba(62,179,140,0.14);  --warning: #E0A64C;  --warning-subtle: rgba(224,166,76,0.14);  --danger: #F87171;  --danger-subtle: rgba(248,113,113,0.14);  --info: #7FB3DD;  --info-subtle: rgba(127,179,221,0.14);
  --shadow-xs: 0 1px 2px rgba(0,0,0,0.3);  --shadow-sm: 0 2px 8px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3);  --shadow-md: 0 8px 24px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.3);  --shadow-lg: 0 20px 60px rgba(0,0,0,0.7), 0 4px 16px rgba(0,0,0,0.4);  --glow-accent: 0 0 0 3px rgba(62,179,140,0.22);
  --radius-xs: 4px;  --radius-sm: 8px;  --radius-md: 12px;  --radius-lg: 16px;  --radius-xl: 22px;
  --sidebar-width: 236px;  --header-height: 58px;
  --transition-fast: 0.12s ease;  --transition: 0.2s ease;  --transition-slow: 0.35s cubic-bezier(0.4,0,0.2,1);
}
```
In `globals.css` the `[data-theme="light"] .card` rule's `border-top` colour becomes `rgba(15,110,86,0.18)` and its shadows use `rgba(23,38,43,…)`; nothing else changes.

- [ ] **Step 3: Write App.jsx, Layout.jsx, Sidebar.jsx, StatusBadge.jsx**

`ui/src/App.jsx`:
```jsx
import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { ViewModeProvider } from './context/ViewModeContext';
import Layout from './components/layout/Layout';
import Login from './pages/Login';

const Capture       = lazy(() => import('./pages/Capture'));
const Home          = lazy(() => import('./pages/Home'));
const MyExpenses    = lazy(() => import('./pages/MyExpenses'));
const ExpenseReview = lazy(() => import('./pages/ExpenseReview'));
const Settings      = lazy(() => import('./pages/Settings'));

const Loading = <div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading…</div>;

function Private({ children, roles }) {
  const { user, loading } = useAuth();
  if (loading) return Loading;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return (
    <Suspense fallback={Loading}>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
        {/* No login on purpose: the pairing token in the URL is the phone's only credential. */}
        <Route path="/capture/:token" element={<Capture />} />
        <Route path="/" element={<Private><Layout /></Private>}>
          <Route index element={<Home />} />
          <Route path="expenses" element={<MyExpenses />} />
          <Route path="expenses/:id" element={<ExpenseReview />} />
          <Route path="settings" element={<Private roles={['admin', 'finance']}><Settings /></Private>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ThemeProvider><ViewModeProvider><AuthProvider>
      <BrowserRouter><AppRoutes /></BrowserRouter>
    </AuthProvider></ViewModeProvider></ThemeProvider>
  );
}
```

`ui/src/components/layout/Layout.jsx`:
```jsx
import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import BottomNav from './BottomNav';
import { useViewMode } from '../../context/ViewModeContext';

export default function Layout() {
  const { isMobile, mobileDrawerOpen, setMobileDrawerOpen } = useViewMode();
  return (
    <div className={`app-layout ${isMobile ? 'mobile-mode' : ''}`}>
      {isMobile && mobileDrawerOpen && (
        <div onClick={() => setMobileDrawerOpen(false)} aria-hidden="true"
             style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 99, animation: 'fadeIn 0.2s ease' }} />
      )}
      <Sidebar />
      <div className="main-content">
        <Header />
        <div className="page-body">
          <Suspense fallback={<div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading…</div>}><Outlet /></Suspense>
        </div>
      </div>
      {isMobile && <BottomNav />}
    </div>
  );
}
```

`ui/src/components/layout/Sidebar.jsx`:
```jsx
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useViewMode } from '../../context/ViewModeContext';

const NAV = [
  { to: '/',         label: 'Home',        desc: 'Add and file expenses', end: true },
  { to: '/expenses', label: 'My expenses', desc: 'Everything you claimed' },
];
const ADMIN_NAV = [{ to: '/settings', label: 'Settings', desc: 'Company, staff, reader' }];

function Item({ to, label, desc, end, onClick }) {
  return (
    <NavLink to={to} end={end} onClick={onClick}
      style={({ isActive }) => ({
        display: 'flex', flexDirection: 'column', gap: 1, padding: '9px 12px', borderRadius: 10, marginBottom: 2, textDecoration: 'none',
        fontSize: 13, fontWeight: isActive ? 600 : 500, color: isActive ? 'var(--text-sidebar-active)' : 'var(--text-sidebar)',
        background: isActive ? 'var(--accent-subtle)' : 'transparent', transition: 'all 0.18s ease',
      })}>
      <span>{label}</span>
      <span style={{ fontSize: 10.5, opacity: 0.6 }}>{desc}</span>
    </NavLink>
  );
}

export default function Sidebar() {
  const { user, logout } = useAuth();
  const { isMobile, mobileDrawerOpen, setMobileDrawerOpen } = useViewMode();
  const navigate = useNavigate();
  const close = () => { if (isMobile) setMobileDrawerOpen(false); };
  const canAdmin = user?.role === 'admin' || user?.role === 'finance';

  return (
    <aside style={{
      position: 'fixed', top: 0, left: 0, bottom: 0, width: isMobile ? 'min(290px, 82vw)' : 'var(--sidebar-width)',
      background: 'var(--bg-sidebar)', borderRight: '1px solid var(--border-sidebar)', display: 'flex', flexDirection: 'column', zIndex: 100,
      transform: isMobile ? (mobileDrawerOpen ? 'translateX(0)' : 'translateX(-100%)') : 'none', transition: 'transform 0.25s ease',
    }}>
      <div style={{ padding: '20px 16px 14px', borderBottom: '1px solid var(--border-sidebar)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 11 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-gradient)', color: 'var(--accent-text)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 16 }}>S</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.2 }}>Solv Expenses</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{user?.companyName || 'Claims'}</div>
        </div>
        {isMobile && <button onClick={() => setMobileDrawerOpen(false)} aria-label="Close menu" style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18 }}>✕</button>}
      </div>
      <nav style={{ flex: 1, padding: '0 8px', overflow: 'auto' }}>
        {NAV.map(i => <Item key={i.to} {...i} onClick={close} />)}
        {canAdmin && ADMIN_NAV.map(i => <Item key={i.to} {...i} onClick={close} />)}
      </nav>
      <div style={{ margin: '8px 8px 12px', padding: '12px 14px', borderRadius: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name || user?.email}</div>
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 8 }}>{user?.role}{user?.department ? ` · ${user.department}` : ''}</div>
        <button className="btn btn-outline btn-sm" style={{ width: '100%' }} onClick={() => { close(); logout(); navigate('/login'); }}>Sign out</button>
      </div>
    </aside>
  );
}
```

`ui/src/components/StatusBadge.jsx`:
```jsx
const META = {
  reading: ['Reading…', 'badge-blue'], 'review-needed': ['Needs review', 'badge-yellow'], reviewed: ['Reviewed', 'badge-green'],
  duplicate: ['Duplicate', 'badge-red'], rejected: ['Rejected', 'badge-red'],
};
export default function StatusBadge({ status }) {
  const [label, cls] = META[status] || [status || '—', 'badge-gray'];
  return <span className={`badge ${cls}`}>{label}</span>;
}
```

- [ ] **Step 4: Build once**

Run: `npm run build:ui`
Expected: vite reports `built in …` (the pages referenced by App.jsx do not exist yet, so this build FAILS until Task 19–21 land; run it again at the end of Task 21). Commit now anyway:

```bash
git add -A && git commit -m "feat(ui): Solv shell — routes, palette, layout, sidebar, login"
```

### Task 19: Home, My expenses, upload controls, phone capture

**Files:**
- Create (copied, adapted): `ui/src/components/receipts/{receipt-upload.js,ReceiptUpload.jsx,PhonePairingModal.jsx,ClaimImport.jsx,CroppedImage.jsx}`, `ui/src/pages/Capture.jsx`
- Create: `ui/src/pages/Home.jsx`, `ui/src/pages/MyExpenses.jsx`, `ui/src/components/ExpenseTable.jsx`

- [ ] **Step 1: Copy and adapt the receipt components**

```bash
for f in receipt-upload.js ReceiptUpload.jsx PhonePairingModal.jsx ClaimImport.jsx CroppedImage.jsx; do cp "$XERO/ui/src/components/receipts/$f" ui/src/components/receipts/; done
cp "$XERO/ui/src/pages/Capture.jsx" ui/src/pages/Capture.jsx
```
Edits:
- `receipt-upload.js`: add `export const MAX_PDF_BYTES = 15 * 1024 * 1024;` and in the PDF branch compare against `MAX_PDF_BYTES` with the message `This PDF is ${humanSize(originalBytes)}; the limit is 15 MB.`
- `PhonePairingModal.jsx`: `r.totalAmount` → `r.total`, `r.vendorName` → `r.merchant`; the title line `Photograph receipts straight into this list.` → `Photograph receipts straight into your expenses.`
- `Capture.jsx`: in the poll merge nothing changes (the server returns `merchant`, `total`, `currency`, `parsed`, `unreadable`); in the render replace `s.vendorName` → `s.merchant` and `s.totalAmount` → `s.total`; the initial `sent` entry uses `merchant: null, total: null`.
- `ReceiptUpload.jsx`: button labels `+ Add expense`, `Import a claim`, `Use my phone`; the compression note keeps its text. It already posts to `/receipts` with `source: 'upload'`.
- `ClaimImport.jsx`: the closing sentence `the claims appear in AR & AP when it finishes` → `the expenses appear in My expenses when it finishes`.

- [ ] **Step 2: Write ExpenseTable.jsx**

`ui/src/components/ExpenseTable.jsx`:
```jsx
import { useNavigate } from 'react-router-dom';
import StatusBadge from './StatusBadge';
import { fmtMoney } from '../utils/format';

// One table for Home and My expenses. A row is the receipt as read: date,
// merchant, original amount, category, state. Click to review.
export default function ExpenseTable({ expenses, empty = 'No expenses yet.' }) {
  const navigate = useNavigate();
  if (!expenses.length) return <div style={{ padding: '22px 0', color: 'var(--text-muted)', fontSize: 13 }}>{empty}</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <thead><tr><th>Date</th><th>Merchant</th><th style={{ textAlign: 'right' }}>Amount</th><th>Category</th><th>Status</th></tr></thead>
        <tbody>
          {expenses.map(e => (
            <tr key={e.id} onClick={() => navigate(`/expenses/${e.id}`)} style={{ cursor: 'pointer' }}>
              <td style={{ whiteSpace: 'nowrap' }}>{e.receiptDate || '—'}</td>
              <td>
                <div style={{ fontWeight: 600 }}>{e.merchant || (e.status === 'reading' ? 'Reading the receipt…' : 'Untitled receipt')}</div>
                {e.errorMsg && <div style={{ fontSize: 11.5, color: 'var(--warning)' }}>{e.errorMsg}</div>}
                {e.purpose && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.purpose}</div>}
              </td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{e.total ? fmtMoney(e.total, e.currency) : '—'}</td>
              <td>{e.lines.length > 1 ? `${e.lines.length} lines` : (e.lines[0]?.category || e.category || '—')}</td>
              <td><StatusBadge status={e.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Write Home.jsx**

`ui/src/pages/Home.jsx`:
```jsx
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import ReceiptUpload from '../components/receipts/ReceiptUpload';
import ExpenseTable from '../components/ExpenseTable';
import { useVisiblePolling } from '../utils/useVisiblePolling';

// The front door: the three ways in, then what needs the person's attention.
export default function Home() {
  const { user } = useAuth();
  const [expenses, setExpenses] = useState([]);
  const load = useCallback(() => api.get('/expenses').then(d => setExpenses(d.expenses)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, () => (expenses.some(e => e.status === 'reading') ? 2500 : 20000));

  const needing = expenses.filter(e => e.status === 'review-needed' || e.status === 'reading');
  const reviewed = expenses.filter(e => e.status === 'reviewed');
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>{greeting}, {user?.name || user?.email}</h1>
          <p>Add a receipt and the reader fills in the merchant, date, amount and category.</p>
        </div>
        <ReceiptUpload onUploaded={load} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 24 }}>
        <div className="stat-card"><div className="stat-label">Needs review</div><div className="stat-value">{needing.length}</div><div className="stat-sub">read by AI, waiting for you</div></div>
        <div className="stat-card"><div className="stat-label">Reviewed</div><div className="stat-value">{reviewed.length}</div><div className="stat-sub">ready for a report</div></div>
        <div className="stat-card"><div className="stat-label">All expenses</div><div className="stat-value">{expenses.length}</div><div className="stat-sub">{user?.baseCurrency || 'SGD'} base currency</div></div>
      </div>

      <div className="card">
        <div className="card-title">Needs your attention</div>
        <div className="card-subtitle">Check the fields against the receipt, add the business purpose, then mark it reviewed.</div>
        <ExpenseTable expenses={needing} empty="Nothing waiting. Add a receipt above." />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write MyExpenses.jsx**

`ui/src/pages/MyExpenses.jsx`:
```jsx
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import ReceiptUpload from '../components/receipts/ReceiptUpload';
import ExpenseTable from '../components/ExpenseTable';
import { useVisiblePolling } from '../utils/useVisiblePolling';

const FILTERS = [['', 'All'], ['review-needed', 'Needs review'], ['reviewed', 'Reviewed'], ['duplicate', 'Duplicates']];

export default function MyExpenses() {
  const [expenses, setExpenses] = useState([]);
  const [status, setStatus] = useState('');
  const load = useCallback(() => api.get(`/expenses${status ? `?status=${status}` : ''}`).then(d => setExpenses(d.expenses)).catch(() => {}), [status]);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, () => (expenses.some(e => e.status === 'reading') ? 2500 : 30000));

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>My expenses</h1><p>Every receipt you have added, newest first.</p></div>
        <ReceiptUpload onUploaded={load} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {FILTERS.map(([k, label]) => (
          <button key={k} className={`btn btn-sm ${status === k ? 'btn-primary' : 'btn-outline'}`} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>
      <div className="card"><ExpenseTable expenses={expenses} /></div>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ui): home, my expenses, upload controls, phone capture"
```

### Task 20: Expense review screen

**Files:**
- Create: `ui/src/pages/ExpenseReview.jsx`

- [ ] **Step 1: Write the page**

```jsx
import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useViewMode } from '../context/ViewModeContext';
import CroppedImage from '../components/receipts/CroppedImage';
import ConfirmDialog from '../components/ConfirmDialog';
import StatusBadge from '../components/StatusBadge';
import { fmtMoney } from '../utils/format';

// Image on the left, fields on the right, so a figure is checked against the
// receipt without switching context. Below the fields, the split into report
// lines, which must add up to the total before the expense can be reviewed.
const FIELDS = [
  ['merchant', 'Merchant', 'text'], ['receiptDate', 'Receipt date', 'date'], ['receiptTime', 'Time', 'text'], ['invoiceNo', 'Invoice no.', 'text'],
  ['currency', 'Currency', 'text'], ['total', 'Total', 'number'], ['tax', 'Tax included', 'number'], ['purpose', 'Business purpose', 'text'],
];
const pick = e => Object.fromEntries(FIELDS.map(([k]) => [k, e[k] ?? '']));
const cents = v => Math.round(Number(v || 0) * 100);

export default function ExpenseReview() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isMobile } = useViewMode();
  const [exp, setExp] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [form, setForm] = useState({});
  const [lines, setLines] = useState([]);
  const [categories, setCategories] = useState([]);
  const [group, setGroup] = useState(null);
  const [rot, setRot] = useState(0);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    const d = await api.get(`/expenses/${id}`);
    setExp(d.expense);
    setForm(pick(d.expense));
    setLines(d.expense.lines.map(l => ({ category: l.category || '', description: l.description || '', amount: l.amount, onBehalfOf: l.onBehalfOf || '' })));
    setImageUrl(d.expense.receipt && d.imageToken ? `/api/receipts/${d.expense.receipt.id}/image?token=${encodeURIComponent(d.imageToken)}` : null);
    api.get(`/expenses/${id}/group`).then(setGroup).catch(() => setGroup(null));
  }, [id]);

  useEffect(() => { setMsg(null); load().catch(e => setMsg({ tone: 'error', text: e.message })); }, [load]);
  useEffect(() => { api.get('/company').then(d => setCategories(d.categories)).catch(() => {}); }, []);
  useEffect(() => {
    // The image token lives five minutes; refresh it, and keep polling while the reader works.
    const t = setInterval(() => load().catch(() => {}), exp?.status === 'reading' ? 2500 : 4 * 60 * 1000);
    return () => clearInterval(t);
  }, [exp?.status, load]);

  const totalCents = cents(form.total);
  const linesCents = lines.reduce((s, l) => s + cents(l.amount), 0);
  const reconciled = lines.length > 0 && totalCents === linesCents;
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setLine = (i, k, v) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  async function save({ quiet } = {}) {
    setBusy('save');
    try {
      const body = { ...form, currency: String(form.currency || '').toUpperCase() };
      const r = await api.patch(`/expenses/${id}`, body);
      if (lines.length && (lines.length !== 1 || cents(lines[0].amount) !== cents(r.expense.total))) {
        await api.put(`/expenses/${id}/lines`, { lines: lines.map(l => ({ ...l, amount: Number(l.amount) })) });
      }
      await load();
      if (!quiet) setMsg({ tone: 'success', text: 'Saved.' });
      return true;
    } catch (e) { setMsg({ tone: 'error', text: e.message }); return false; }
    finally { setBusy(''); }
  }
  async function markReviewed() {
    if (!(await save({ quiet: true }))) return;
    setBusy('review');
    try {
      await api.patch(`/expenses/${id}/status`, { status: 'reviewed' });
      const next = group?.siblings?.find(s => s.id !== id && s.status !== 'reviewed');
      if (next) navigate(`/expenses/${next.id}`); else { await load(); setMsg({ tone: 'success', text: 'Marked reviewed.' }); }
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(''); }
  }
  async function reread() {
    setBusy('reread');
    try {
      const r = await api.post(`/expenses/${id}/reread`, {});
      await load();
      setMsg(r.ok ? { tone: 'success', text: `Read again (${r.confidence} confidence).` } : { tone: 'warning', text: 'The reader could not make out this receipt. Type the fields by hand.' });
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(''); }
  }
  async function remove() {
    setConfirm(null);
    try { await api.delete(`/expenses/${id}`); navigate('/expenses'); } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  }

  if (!exp) return <div style={{ color: 'var(--text-muted)' }}>{msg?.text || 'Loading…'}</div>;
  const isPdf = exp.receipt?.mime === 'application/pdf';
  const idx = group?.siblings?.findIndex(s => s.id === id) ?? -1;
  const prev = idx > 0 ? group.siblings[idx - 1] : null;
  const next = idx >= 0 && idx < (group?.siblings?.length || 0) - 1 ? group.siblings[idx + 1] : null;

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}><Link to="/expenses" style={{ color: 'inherit' }}>← My expenses</Link></div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{exp.merchant || 'Untitled receipt'} <StatusBadge status={exp.status} /></h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {prev && <button className="btn btn-outline btn-sm" onClick={() => navigate(`/expenses/${prev.id}`)}>← Prev</button>}
          {next && <button className="btn btn-outline btn-sm" onClick={() => navigate(`/expenses/${next.id}`)}>Next →</button>}
          <button className="btn btn-outline btn-sm" onClick={() => setConfirm('delete')}>Delete</button>
        </div>
      </div>

      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}
      {exp.errorMsg && <div className="alert alert-warning"><span className="alert-icon">!</span>{exp.errorMsg}{exp.duplicateOf && <> · <Link to={`/expenses/${exp.duplicateOf}`}>see the other one</Link></>}</div>}
      {group?.split && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>{group.groupType === 'batch' ? 'Batch import' : 'Split from one file'} · {group.index} of {group.total}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) 460px', gap: 20, alignItems: 'start' }}>
        {/* Receipt */}
        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {exp.receipt ? `${isPdf ? 'PDF' : 'Photo'}${exp.receipt.pages ? ` · ${exp.receipt.pages} page${exp.receipt.pages === 1 ? '' : 's'}` : ''}${exp.page ? ` · page ${exp.page}` : ''}` : 'No file'}
              {exp.aiReadAt && ` · read by AI, ${exp.aiConfidence || 'low'} confidence`}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {!isPdf && <button className="btn btn-outline btn-sm" onClick={() => setRot(r => (r + 90) % 360)}>Rotate</button>}
              <button className="btn btn-outline btn-sm" disabled={busy === 'reread' || !exp.receipt} onClick={reread}>{busy === 'reread' ? 'Reading…' : 'Re-read'}</button>
              {imageUrl && <a className="btn btn-outline btn-sm" href={imageUrl} target="_blank" rel="noopener noreferrer">Open original</a>}
            </div>
          </div>
          {!imageUrl ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No receipt file.</div>
            : isPdf ? <iframe title="Receipt" src={`${imageUrl}#page=${exp.page || 1}&zoom=page-width`} style={{ width: '100%', height: isMobile ? 480 : 760, border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
            : <div style={{ overflow: 'auto', maxHeight: 760 }}><CroppedImage src={imageUrl} box={exp.box} alt="Receipt" style={{ maxWidth: '100%', transform: `rotate(${rot}deg)`, transition: 'transform .2s ease' }} /></div>}
        </div>

        {/* Fields */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-title">Receipt details</div>
            <div className="card-subtitle">Read from the receipt. Check each one, then say what it was for.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
              {FIELDS.map(([k, label, type]) => (
                <div className="form-group" key={k} style={{ gridColumn: k === 'merchant' || k === 'purpose' ? '1 / -1' : 'auto' }}>
                  <label className="form-label" htmlFor={`f-${k}`}>{label}</label>
                  <input id={`f-${k}`} className="form-input" type={type} step={type === 'number' ? '0.01' : undefined} value={form[k] ?? ''} onChange={e => set(k, e.target.value)}
                         placeholder={k === 'purpose' ? 'Client site visit, Chakan plant' : k === 'currency' ? 'INR' : ''} />
                </div>
              ))}
            </div>
            {exp.description && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reader's note: {exp.description}</div>}
          </div>

          <div className="card">
            <div className="card-title">Lines</div>
            <div className="card-subtitle">One line per category on the report. They must add up to the total{form.currency ? ` in ${form.currency}` : ''}.</div>
            {lines.map((l, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.4fr 0.9fr auto', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <select className="form-input" value={l.category} onChange={e => setLine(i, 'category', e.target.value)} aria-label="Category">
                  <option value="">Category…</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input className="form-input" value={l.description} placeholder="Rooms, 3 nights" onChange={e => setLine(i, 'description', e.target.value)} aria-label="Description" />
                <input className="form-input" type="number" step="0.01" value={l.amount} onChange={e => setLine(i, 'amount', e.target.value)} style={{ textAlign: 'right' }} aria-label="Amount" />
                <button className="btn btn-ghost btn-sm" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} aria-label="Remove line" title="Remove line">✕</button>
                <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={!!l.onBehalfOf} onChange={e => setLine(i, 'onBehalfOf', e.target.checked ? (l.onBehalfOf || ' ') : '')} /> paid on behalf of
                  </label>
                  {!!l.onBehalfOf && <input className="form-input" style={{ padding: '4px 8px', fontSize: 12, maxWidth: 220 }} value={l.onBehalfOf.trim()} placeholder="Colleague's name" onChange={e => setLine(i, 'onBehalfOf', e.target.value || ' ')} />}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: 12.5 }}>
              <button className="btn btn-outline btn-sm" onClick={() => setLines(ls => [...ls, { category: '', description: '', amount: Math.max(0, (totalCents - linesCents) / 100).toFixed(2), onBehalfOf: '' }])}>+ Line</button>
              <span style={{ color: reconciled ? 'var(--success)' : 'var(--danger)', fontVariantNumeric: 'tabular-nums' }}>
                lines {fmtMoney(linesCents / 100, form.currency)} {reconciled ? '✓' : `≠ total ${fmtMoney(totalCents / 100, form.currency)}`}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button className="btn btn-outline" disabled={!!busy} onClick={() => save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            <button className="btn btn-primary" disabled={!!busy || !reconciled} title={reconciled ? '' : 'The lines must add up to the total first'} onClick={markReviewed}>
              {busy === 'review' ? 'Saving…' : (next ? 'Mark reviewed → next' : 'Mark reviewed')}
            </button>
          </div>
        </div>
      </div>

      {confirm === 'delete' && (
        <ConfirmDialog title="Delete this expense?" message="The receipt file goes with it unless another expense still uses it." confirmLabel="Delete" danger onConfirm={remove} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat(ui): expense review with receipt viewer, fields and reconciled lines"
```

### Task 21: Settings page

**Files:**
- Create: `ui/src/pages/Settings.jsx`

- [ ] **Step 1: Write the page**

```jsx
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog from '../components/ConfirmDialog';

const POLICIES = [['receipt_date', 'Rate on the receipt date'], ['submission_date', 'Rate on the submission date'], ['monthly_fixed', 'Monthly fixed table (finance enters rates)']];
const ROLES = ['employee', 'manager', 'finance', 'admin'];

export default function Settings() {
  const { user, refreshUser } = useAuth();
  const [company, setCompany] = useState(null);
  const [columns, setColumns] = useState('');
  const [users, setUsers] = useState([]);
  const [keys, setKeys] = useState([]);
  const [newUser, setNewUser] = useState({ email: '', password: '', name: '', role: 'employee', department: '', employeeId: '', managerId: '' });
  const [newKey, setNewKey] = useState({ apiKey: '', label: '' });
  const [msg, setMsg] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const isAdmin = user?.role === 'admin';

  async function loadAll() {
    const c = await api.get('/company'); setCompany(c.company); setColumns(c.company.reportColumns.join(', '));
    setUsers((await api.get('/users')).users);
    setKeys((await api.get('/company/llm-keys')).keys);
  }
  useEffect(() => { loadAll().catch(e => setMsg({ tone: 'error', text: e.message })); }, []);
  const ok = text => setMsg({ tone: 'success', text });
  const fail = e => setMsg({ tone: 'error', text: e.message });

  async function saveCompany(e) {
    e.preventDefault();
    try {
      await api.patch('/company', { name: company.name, baseCurrency: company.baseCurrency.toUpperCase(), fxPolicy: company.fxPolicy, timezone: company.timezone,
                                     reportColumns: columns.split(',').map(s => s.trim()).filter(Boolean) });
      await loadAll(); await refreshUser(); ok('Company settings saved.');
    } catch (err) { fail(err); }
  }
  async function addUser(e) {
    e.preventDefault();
    try { await api.post('/users', { ...newUser, managerId: newUser.managerId || null }); setNewUser({ email: '', password: '', name: '', role: 'employee', department: '', employeeId: '', managerId: '' }); await loadAll(); ok('Staff member added.'); }
    catch (err) { fail(err); }
  }
  async function patchUser(id, patch) { try { await api.patch(`/users/${id}`, patch); await loadAll(); } catch (err) { fail(err); } }
  async function addKey(e) {
    e.preventDefault();
    try { await api.post('/company/llm-keys', newKey); setNewKey({ apiKey: '', label: '' }); await loadAll(); ok('Reader key added.'); } catch (err) { fail(err); }
  }

  if (!company) return <div style={{ color: 'var(--text-muted)' }}>{msg?.text || 'Loading…'}</div>;
  const managers = users.filter(u => u.role === 'manager' || u.role === 'admin' || u.role === 'finance');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 900 }}>
      <div className="page-header"><h1>Settings</h1><p>Company, staff and the receipt reader.</p></div>
      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}

      <form className="card" onSubmit={saveCompany}>
        <div className="card-title">Company</div>
        <div className="card-subtitle">The base currency every report totals in, and how foreign amounts are converted.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 12px' }}>
          <div className="form-group"><label className="form-label" htmlFor="c-name">Name</label><input id="c-name" className="form-input" value={company.name} onChange={e => setCompany({ ...company, name: e.target.value })} /></div>
          <div className="form-group"><label className="form-label" htmlFor="c-ccy">Base currency</label><input id="c-ccy" className="form-input" value={company.baseCurrency} maxLength={3} onChange={e => setCompany({ ...company, baseCurrency: e.target.value })} /></div>
          <div className="form-group"><label className="form-label" htmlFor="c-tz">Timezone</label><input id="c-tz" className="form-input" value={company.timezone} onChange={e => setCompany({ ...company, timezone: e.target.value })} /></div>
          <div className="form-group"><label className="form-label" htmlFor="c-fx">Exchange-rate policy</label>
            <select id="c-fx" className="form-input" value={company.fxPolicy} onChange={e => setCompany({ ...company, fxPolicy: e.target.value })}>{POLICIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        </div>
        <div className="form-group"><label className="form-label" htmlFor="c-cols">Report columns (in order, comma separated)</label><input id="c-cols" className="form-input" value={columns} onChange={e => setColumns(e.target.value)} /></div>
        <button className="btn btn-primary" type="submit">Save company</button>
      </form>

      <div className="card">
        <div className="card-title">Staff</div>
        <div className="card-subtitle">Who can claim, who approves, who pays. A manager approves their direct reports.</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Role</th><th>Manager</th><th></th></tr></thead>
            <tbody>{users.map(u => (
              <tr key={u.id}>
                <td>{u.name || '—'}{u.employeeId ? <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.employeeId}</div> : null}</td>
                <td>{u.email}</td><td>{u.department || '—'}</td>
                <td>{isAdmin ? <select className="form-input" style={{ padding: '4px 8px' }} value={u.role} onChange={e => patchUser(u.id, { role: e.target.value })}>{ROLES.map(r => <option key={r}>{r}</option>)}</select> : u.role}</td>
                <td>{isAdmin ? <select className="form-input" style={{ padding: '4px 8px' }} value={u.managerId || ''} onChange={e => patchUser(u.id, { managerId: e.target.value || null })}><option value="">—</option>{managers.filter(m => m.id !== u.id).map(m => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}</select> : (managers.find(m => m.id === u.managerId)?.name || '—')}</td>
                <td>{isAdmin && u.id !== user.id && <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(u)}>Remove</button>}</td>
              </tr>))}</tbody>
          </table>
        </div>
        {isAdmin && (
          <form onSubmit={addUser} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 14, alignItems: 'end' }}>
            <input className="form-input" placeholder="Name" value={newUser.name} onChange={e => setNewUser({ ...newUser, name: e.target.value })} aria-label="Name" />
            <input className="form-input" placeholder="Email" type="email" required value={newUser.email} onChange={e => setNewUser({ ...newUser, email: e.target.value })} aria-label="Email" />
            <input className="form-input" placeholder="Password (8+)" type="password" required minLength={8} value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })} aria-label="Password" />
            <input className="form-input" placeholder="Department" value={newUser.department} onChange={e => setNewUser({ ...newUser, department: e.target.value })} aria-label="Department" />
            <input className="form-input" placeholder="Employee ID" value={newUser.employeeId} onChange={e => setNewUser({ ...newUser, employeeId: e.target.value })} aria-label="Employee ID" />
            <select className="form-input" value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value })} aria-label="Role">{ROLES.map(r => <option key={r}>{r}</option>)}</select>
            <select className="form-input" value={newUser.managerId} onChange={e => setNewUser({ ...newUser, managerId: e.target.value })} aria-label="Manager"><option value="">No manager</option>{managers.map(m => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}</select>
            <button className="btn btn-primary" type="submit">Add staff</button>
          </form>
        )}
      </div>

      <div className="card">
        <div className="card-title">Receipt reader keys</div>
        <div className="card-subtitle">Gemini API keys, shared by the company. Keys rotate when one runs out of quota.</div>
        {keys.map(k => (
          <div key={k.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
            <span><code>{k.keyMasked}</code> {k.label && <span style={{ color: 'var(--text-muted)' }}>· {k.label}</span>}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => api.delete(`/company/llm-keys/${k.id}`).then(loadAll).catch(fail)}>Remove</button>
          </div>
        ))}
        <form onSubmit={addKey} style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input className="form-input" style={{ flex: 2, minWidth: 220 }} placeholder="AIza…" required value={newKey.apiKey} onChange={e => setNewKey({ ...newKey, apiKey: e.target.value })} aria-label="API key" />
          <input className="form-input" style={{ flex: 1, minWidth: 120 }} placeholder="Label" value={newKey.label} onChange={e => setNewKey({ ...newKey, label: e.target.value })} aria-label="Label" />
          <button className="btn btn-primary" type="submit">Add key</button>
        </form>
      </div>

      {confirm && <ConfirmDialog title={`Remove ${confirm.name || confirm.email}?`} message="Their expenses stay; they can no longer sign in." confirmLabel="Remove" danger
                                 onConfirm={() => api.delete(`/users/${confirm.id}`).then(() => { setConfirm(null); return loadAll(); }).catch(fail)} onCancel={() => setConfirm(null)} />}
    </div>
  );
}
```

- [ ] **Step 2: Build, lint, test, commit**

Run: `npm run build:ui && npm run lint && npm test`
Expected: vite builds; eslint reports no errors (warnings allowed); jest green including `ui-api-paths` and `lint` tests.
```bash
git add -A && git commit -m "feat(ui): settings — company, staff and reader keys"
```

### Task 22: Acceptance on the two Marriott folios

**Files:**
- Create: `main/scripts/read-sample.js`, `docs/acceptance/2026-09-18-folio-read.md`

- [ ] **Step 1: Write the script**

`main/scripts/read-sample.js`:
```js
// Reads one receipt file through the real reader and prints what Solv would
// store. Needs a Gemini key: Gemini_API_KEY in main/.env or the environment.
//   node main/scripts/read-sample.js "samples/receipts/jw-marriott-mumbai.pdf"
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const fs = require('fs');
const path = require('path');
const { readOne, buildLines } = require('../receipts/read-receipt');

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node main/scripts/read-sample.js <file.pdf|jpg>'); process.exit(1); }
  const buffer = fs.readFileSync(file);
  const mime = path.extname(file).toLowerCase() === '.pdf' ? 'application/pdf' : (path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg');
  const t0 = Date.now();
  const r = await readOne(null, buffer, mime);
  if (!r) { console.log(JSON.stringify({ file, read: false }, null, 2)); process.exit(2); }
  const lines = buildLines(r, 'Other');
  console.log(JSON.stringify({ file, seconds: (Date.now() - t0) / 1000, merchant: r.merchant, date: r.date, time: r.time, invoiceNumber: r.invoiceNumber,
    currency: r.currency, total: r.total, tax: r.tax, category: r.category, confidence: r.confidence, description: r.description,
    lineItems: r.lineItems.length, lines }, null, 2));
})().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run both folios and record the result**

Run (with a key in `main/.env`):
```bash
node main/scripts/read-sample.js "samples/receipts/jw-marriott-mumbai.pdf"
node main/scripts/read-sample.js "samples/receipts/courtyard-marriott-pune.pdf"
```
Expected, per the checklist: one result each (not one per page); merchant names the hotel; currency INR; totals 44,309.00 and 88,188.77; tax 6,759.00 and 13,452.52; lines split Lodging and Meals summing to the total; a line marked on behalf of Tan Suan Kuan on each. Write the actual JSON and a pass/fail per checklist row into `docs/acceptance/2026-09-18-folio-read.md`. Any row that fails becomes a prompt or normaliser fix in `receipt-parser.js` with a unit test, and the script is rerun.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(acceptance): both Marriott folios read end to end, results recorded"
```

---

## Self-review notes

- **Spec coverage (Phases 0–1):** companies/roles (Task 4), receipts + expenses + lines (10), scanned PDFs (11, 14), multi-page documents (12, 13, 14), per-line categories and on-behalf (12, 14), phone capture (15), batch import (17), review screen and line split (20), settings (21), acceptance on the samples (22). FX, reports, approvals and Xero are Phases 2–5 by design and have no tasks here.
- **Names used across tasks:** `store.createReceipt/getReceipt/findReceiptByHash/updateReceipt/deleteReceipt/countExpensesForReceipt/countExpensesForFile/createExpense/getExpense/updateExpense/listExpenses/expensesForReceipt/deleteExpense/getLines/replaceLines/linesReconcile/dedupView/toCents` (Task 10) are the only store calls made by Tasks 14–17; `readReceipt/readOne/applyRead/buildLines/flagIfSuspected` (14) are what 15–17 call; `users.findById/getUserDefaults/getGeminiKeysForUser/reportsTo/getCompany` (4) are what 5, 15, 16, 17 call; `parseReceiptImage/parseReceiptText/parseReceiptPages/parseReceiptBatch` (12) are what 14 and 17 call.
