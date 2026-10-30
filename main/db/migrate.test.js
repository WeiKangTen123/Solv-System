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

    // DROP TABLE takes the table's indexes with it, and schema.sql ran before
    // the step, so nothing put them back until the next boot.
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'expense_reports'").all().map(r => r.name);
    expect(idx).toContain('idx_reports_user');
  });

  // The one migration that rebuilds a table rather than adding a column. It has
  // to carry the rows across untouched, and it has to be safe to meet twice.
  test('an older database gains the case kind without losing a report', () => {
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('c1', 'Solv', '2026-01-01')").run();
    db.prepare("INSERT INTO users (id, company_id, email, password, role, created_at) VALUES ('u1','c1','a@b.c','x','user','2026-01-01')").run();

    // put the table back the way it was before this migration existed
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='expense_reports'").get().sql;
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE expense_reports');
    // (the default was 'trip' then; 'case' anywhere in the table reads as migrated)
    db.exec(sql.replace("DEFAULT 'case' CHECK (kind IN ('trip', 'period', 'case'))", "DEFAULT 'trip' CHECK (kind IN ('trip', 'period'))"));
    db.pragma('foreign_keys = ON');
    db.prepare(`INSERT INTO expense_reports (id, company_id, user_id, number, kind, title, status, advances_cents, created_at)
                VALUES ('r1','c1','u1','EXP-2026-0001','trip','India trip','open', 5000, '2026-09-01')`).run();
    expect(() => db.prepare("INSERT INTO expense_reports (id, company_id, user_id, number, kind, status, advances_cents, created_at) VALUES ('r2','c1','u1','EXP-2026-0002','case','open',0,'2026-09-02')").run()).toThrow();
    db.pragma('user_version = 1');   // as if this step had never run

    require('./migrate').run();

    const kept = db.prepare("SELECT * FROM expense_reports WHERE id = 'r1'").get();
    expect(kept).toMatchObject({ number: 'EXP-2026-0001', title: 'India trip', status: 'open', advances_cents: 5000, kind: 'trip' });
    expect(() => db.prepare("INSERT INTO expense_reports (id, company_id, user_id, number, kind, status, advances_cents, created_at) VALUES ('r2','c1','u1','EXP-2026-0002','case','open',0,'2026-09-02')").run()).not.toThrow();
    expect(() => db.prepare("INSERT INTO expense_reports (id, company_id, user_id, number, kind, status, advances_cents, created_at) VALUES ('r3','c1','u1','EXP-2026-0003','banana','open',0,'2026-09-02')").run()).toThrow();
    expect(() => require('./migrate').run()).not.toThrow();
  });

  // Step 5: four roles become two and six states become two, with every row
  // carried across and the columns of the old chain left behind.
  test('an older database with managers and an approval chain becomes two roles and two states', () => {
    const fs = require('fs'), path = require('path');
    const ddl = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const oldUsers = ddl.match(/CREATE TABLE IF NOT EXISTS users \([\s\S]*?\n\);/)[0]
      .replace("role         TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),",
               "role         TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'manager', 'finance', 'admin')),\n  manager_id   TEXT REFERENCES users(id) ON DELETE SET NULL,");
    const oldReports = ddl.match(/CREATE TABLE IF NOT EXISTS expense_reports \([\s\S]*?\n\);/)[0]
      .replace("status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'claimed')),",
               "status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'claimed', 'posted')),\n  submitted_at TEXT,\n  approved_by TEXT,\n  approved_at TEXT,\n  rejected_reason TEXT,");
    expect(oldUsers).toContain('manager_id'); expect(oldReports).toContain("'posted'");
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE expense_reports'); db.exec('DROP TABLE users');
    db.exec(oldUsers.replace('IF NOT EXISTS ', '')); db.exec(oldReports.replace('IF NOT EXISTS ', ''));
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('c1', 'Solv', '2026-01-01')").run();
    const u = db.prepare("INSERT INTO users (id, company_id, email, password, role, manager_id, created_at) VALUES (?,?,?,?,?,?,?)");
    u.run('a1','c1','a@s.sg','x','admin',null,'2026-01-01'); u.run('m1','c1','m@s.sg','x','manager',null,'2026-01-01');
    u.run('f1','c1','f@s.sg','x','finance',null,'2026-01-01'); u.run('e1','c1','e@s.sg','x','employee','m1','2026-01-01');
    const r = db.prepare("INSERT INTO expense_reports (id, company_id, user_id, number, kind, title, status, approved_by, claimed_at, xero_invoice_id, advances_cents, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const [i, st] of ['draft', 'submitted', 'approved', 'rejected', 'claimed', 'posted'].entries())
      r.run(`r${i}`, 'c1', 'e1', `EXP-${i}`, 'trip', `T${i}`, st, st === 'approved' ? 'm1' : null, st === 'claimed' ? '2026-09-12T00:00:00Z' : null, st === 'posted' ? 'INV-9' : null, 500, '2026-09-01');
    db.pragma('user_version = 4');

    require('./migrate').run();

    expect(db.prepare('SELECT id, role FROM users ORDER BY id').all()).toEqual([{ id: 'a1', role: 'admin' }, { id: 'e1', role: 'user' }, { id: 'f1', role: 'user' }, { id: 'm1', role: 'user' }]);
    expect(db.prepare('SELECT id, status FROM expense_reports ORDER BY id').all().map(x => x.status)).toEqual(['open', 'open', 'open', 'open', 'claimed', 'claimed']);
    expect(db.prepare("SELECT title, advances_cents, xero_invoice_id FROM expense_reports WHERE id = 'r5'").get()).toEqual({ title: 'T5', advances_cents: 500, xero_invoice_id: 'INV-9' });
    expect(db.prepare("SELECT claimed_at FROM expense_reports WHERE id = 'r4'").get().claimed_at).toBe('2026-09-12T00:00:00Z');
    expect(db.prepare('PRAGMA table_info(users)').all().map(c => c.name)).not.toContain('manager_id');
    expect(db.prepare('PRAGMA table_info(expense_reports)').all().map(c => c.name)).not.toContain('approved_at');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='expense_reports'").all().map(x => x.name)).toContain('idx_reports_user');
    expect(() => require('./migrate').run()).not.toThrow();
  });

  test('a lower-numbered step still runs on a new database', () => {
    // Each step stamps the database with its own number and refuses to run if
    // the stamp is already higher, so a step declared after a higher-numbered
    // one never runs. Step 2 sat above step 1 and step 1 was skipped for good.
    const src = require('fs').readFileSync(require('path').join(__dirname, 'migrate.js'), 'utf8');
    const numbers = [...src.matchAll(/_step\((\d+),/g)].map(m => Number(m[1]));
    expect(numbers.length).toBeGreaterThan(1);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);       // and none reused
    expect(db.pragma('user_version', { simple: true })).toBe(Math.max(...numbers));
    // preflight reports a box's schema against this without migrating it, so a
    // step added without moving it would have preflight calling a current box stale.
    expect(require('./migrate').LATEST).toBe(Math.max(...numbers));
  });

  test('expenses reject an unknown status', () => {
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('c1', 'Solv', '2026-01-01')").run();
    db.prepare("INSERT INTO users (id, company_id, email, password, role, created_at) VALUES ('u1','c1','a@b.c','x','user','2026-01-01')").run();
    expect(() => db.prepare("INSERT INTO expenses (id, company_id, user_id, status, created_at) VALUES ('e1','c1','u1','bogus','2026-01-01')").run()).toThrow();
  });
  // A rebuild (_rebuild) recreates a table from schema.sql's DDL and copies
  // only the columns that DDL names. Twelve columns existed only through
  // _ensureColumn, so rebuilding fx_rates or company_credentials would have
  // dropped every close, every manual rate's author and the encrypted OXR key,
  // and the next boot would have added the columns back empty.
  test('every column a migration adds is also in schema.sql', () => {
    const fs = require('fs');
    const path = require('path');
    const Database = require('better-sqlite3');
    const fresh = new Database(':memory:');
    fresh.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    const columns = t => fresh.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    const src = fs.readFileSync(path.join(__dirname, 'migrate.js'), 'utf8');
    const missing = [];
    for (const [, table, col] of src.matchAll(/_ensureColumn\((\w+|'[^']+'),\s*'(\w+)'/g)) {
      const tables = table === 'table' ? ['company_gemini_keys', 'user_gemini_keys'] : [table.replace(/'/g, '')];
      for (const t of tables) if (!columns(t).includes(col)) missing.push(`${t}.${col}`);
    }
    expect(missing).toEqual([]);
  });

  test('deleting an expense does not scan every expense', () => {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM expenses WHERE duplicate_of = ?').all('x').map(r => r.detail).join(' ');
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_expenses_duplicate_of/);
    const group = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM receipts WHERE group_id = ?').all('x').map(r => r.detail).join(' ');
    expect(group).toMatch(/USING (COVERING )?INDEX idx_receipts_group/);
  });
  // Step 7 gives a company made before the default board its ten currencies,
  // beside any it chose, never past ten and never its own; it runs once, so a
  // currency an admin takes off later stays off.
  test('an existing company gets the default board once, up to ten, never its own currency', () => {
    const { DEFAULT_BOARD } = require('../intake/currencies');
    db.prepare("INSERT INTO companies (id, name, base_currency, created_at) VALUES ('c1', 'Solv', 'SGD', '2026-01-01'), ('c2', 'Kedai', 'MYR', '2026-01-01')").run();
    db.prepare("INSERT INTO fx_watch (company_id, currency, added_by, added_at) VALUES ('c2', 'GBP', 'a@x', '2026-01-01'), ('c2', 'AUD', 'a@x', '2026-01-01')").run();
    db.pragma('user_version = 6');
    require('./migrate').run();
    const chosen = id => db.prepare('SELECT currency FROM fx_watch WHERE company_id = ? ORDER BY currency').all(id).map(r => r.currency);
    expect(chosen('c1')).toEqual([...DEFAULT_BOARD].sort());
    expect(chosen('c2')).toHaveLength(10);
    expect(chosen('c2')).toEqual(expect.arrayContaining(['GBP', 'AUD']));
    expect(chosen('c2')).not.toContain('MYR');
    db.prepare("DELETE FROM fx_watch WHERE company_id = 'c1' AND currency = 'PHP'").run();
    require('./migrate').run();
    expect(chosen('c1')).not.toContain('PHP');
  });

  // Step 8: a case can be a draft with no number. A database at step 7 holds
  // cases that each have one, and every one of them must come across intact.
  test('a database at step 7 keeps every case and number, and then takes a draft with no number', () => {
    const fs = require('fs'), path = require('path');
    const ddl = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const step7 = ddl.match(/CREATE TABLE IF NOT EXISTS expense_reports \([\s\S]*?\n\);/)[0]
      .replace(/number {10}TEXT,[^\n]*/, 'number          TEXT NOT NULL,')
      .replace("DEFAULT 'case' CHECK (kind", "DEFAULT 'trip' CHECK (kind")
      .replace("CHECK (status IN ('draft', 'open', 'claimed'))", "CHECK (status IN ('open', 'claimed'))")
      .replace(/\n {2}cover_ai[^\n]*/, '');
    expect(step7).toContain('number          TEXT NOT NULL,');
    expect(step7).not.toContain('cover_ai');
    expect(step7).not.toContain("'draft'");
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE expense_reports');
    db.exec(step7.replace('IF NOT EXISTS ', ''));
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('c1', 'Solv', '2026-01-01')").run();
    db.prepare("INSERT INTO users (id, company_id, email, password, role, created_at) VALUES ('u1','c1','a@b.c','x','user','2026-01-01')").run();
    const ins = db.prepare('INSERT INTO expense_reports (id, company_id, user_id, number, kind, title, status, advances_cents, claimed_at, xero_invoice_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('r1', 'c1', 'u1', 'EXP-2026-0001', 'trip', 'India trip', 'open', 5000, null, null, '2026-09-01');
    ins.run('r2', 'c1', 'u1', 'EXP-2026-0002', 'period', 'September', 'claimed', 0, '2026-10-01T00:00:00Z', 'INV-1', '2026-09-02');
    db.prepare("INSERT INTO expenses (id, company_id, user_id, report_id, status, created_at) VALUES ('e1','c1','u1','r1','reviewed','2026-09-01')").run();
    expect(() => db.prepare("INSERT INTO expense_reports (id, company_id, user_id, status, created_at) VALUES ('d0','c1','u1','draft','2026-10-01')").run()).toThrow();
    db.pragma('user_version = 7');

    require('./migrate').run();

    expect(db.pragma('user_version', { simple: true })).toBe(require('./schema-version').LATEST);
    expect(db.prepare('SELECT id, number, kind, title, status, advances_cents, claimed_at, xero_invoice_id FROM expense_reports ORDER BY id').all()).toEqual([
      { id: 'r1', number: 'EXP-2026-0001', kind: 'trip', title: 'India trip', status: 'open', advances_cents: 5000, claimed_at: null, xero_invoice_id: null },
      { id: 'r2', number: 'EXP-2026-0002', kind: 'period', title: 'September', status: 'claimed', advances_cents: 0, claimed_at: '2026-10-01T00:00:00Z', xero_invoice_id: 'INV-1' },
    ]);
    expect(db.prepare("SELECT report_id FROM expenses WHERE id = 'e1'").get().report_id).toBe('r1');
    expect(db.prepare('PRAGMA table_info(expense_reports)').all().map(c => c.name)).toContain('cover_ai');
    db.prepare("INSERT INTO expense_reports (id, company_id, user_id, status, created_at) VALUES ('d1','c1','u1','draft','2026-10-01')").run();
    expect(db.prepare("SELECT number, kind, status FROM expense_reports WHERE id = 'd1'").get()).toEqual({ number: null, kind: 'case', status: 'draft' });
    expect(() => db.prepare("INSERT INTO expense_reports (id, company_id, user_id, status, created_at) VALUES ('d2','c1','u1','paid','2026-10-01')").run()).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='expense_reports'").all().map(x => x.name)).toContain('idx_reports_user');
    expect(() => require('./migrate').run()).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM expense_reports').get().n).toBe(3);
  });

  // Step 9: a receipt keeps what it printed, and a line the taxes inside it.
  // A database at step 8 has neither column; its receipts and lines come
  // through untouched, with nothing kept (null), which is what an old receipt is.
  test('a database at step 8 gains the printed record and the line taxes, both empty on what was there', () => {
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('c1', 'Solv', '2026-01-01')").run();
    db.prepare("INSERT INTO users (id, company_id, email, password, role, created_at) VALUES ('u1','c1','a@b.c','x','user','2026-01-01')").run();
    db.prepare("INSERT INTO expenses (id, company_id, user_id, status, total_cents, tax_cents, created_at) VALUES ('e1','c1','u1','reviewed', 2785, 158, '2026-10-08')").run();
    db.prepare("INSERT INTO expense_lines (expense_id, category, amount_cents) VALUES ('e1', 'Meals', 2785)").run();
    db.exec('ALTER TABLE expenses DROP COLUMN printed');
    db.exec('ALTER TABLE expense_lines DROP COLUMN taxes');
    db.pragma('user_version = 8');

    require('./migrate').run();

    expect(db.pragma('user_version', { simple: true })).toBe(9);
    expect(db.prepare("SELECT total_cents, tax_cents, printed FROM expenses WHERE id = 'e1'").get()).toEqual({ total_cents: 2785, tax_cents: 158, printed: null });
    expect(db.prepare("SELECT category, amount_cents, taxes FROM expense_lines WHERE expense_id = 'e1'").get()).toEqual({ category: 'Meals', amount_cents: 2785, taxes: null });
    const e = require('../store/expenses').getExpense('e1');
    expect(e.printed).toBeNull();
    expect(e.lines[0].taxes).toBeNull();
    expect(() => require('./migrate').run()).not.toThrow();
  });
});
