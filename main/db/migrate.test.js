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
    db.exec(sql.replace("CHECK (kind IN ('trip', 'period', 'case'))", "CHECK (kind IN ('trip', 'period'))"));
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
      .replace("status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed')),",
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
});
