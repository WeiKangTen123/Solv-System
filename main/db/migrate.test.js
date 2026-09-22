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
    db.prepare("INSERT INTO users (id, company_id, email, password, role, created_at) VALUES ('u1','c1','a@b.c','x','employee','2026-01-01')").run();

    // put the table back the way it was before this migration existed
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='expense_reports'").get().sql;
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE expense_reports');
    db.exec(sql.replace("CHECK (kind IN ('trip', 'period', 'case'))", "CHECK (kind IN ('trip', 'period'))"));
    db.pragma('foreign_keys = ON');
    db.prepare(`INSERT INTO expense_reports (id, company_id, user_id, number, kind, title, status, advances_cents, created_at)
                VALUES ('r1','c1','u1','EXP-2026-0001','trip','India trip','approved', 5000, '2026-09-01')`).run();
    expect(() => db.prepare("INSERT INTO expense_reports (id, company_id, user_id, number, kind, status, advances_cents, created_at) VALUES ('r2','c1','u1','EXP-2026-0002','case','draft',0,'2026-09-02')").run()).toThrow();
    db.pragma('user_version = 1');   // as if this step had never run

    require('./migrate').run();

    const kept = db.prepare("SELECT * FROM expense_reports WHERE id = 'r1'").get();
    expect(kept).toMatchObject({ number: 'EXP-2026-0001', title: 'India trip', status: 'approved', advances_cents: 5000, kind: 'trip' });
    expect(() => db.prepare("INSERT INTO expense_reports (id, company_id, user_id, number, kind, status, advances_cents, created_at) VALUES ('r2','c1','u1','EXP-2026-0002','case','draft',0,'2026-09-02')").run()).not.toThrow();
    expect(() => db.prepare("INSERT INTO expense_reports (id, company_id, user_id, number, kind, status, advances_cents, created_at) VALUES ('r3','c1','u1','EXP-2026-0003','banana','draft',0,'2026-09-02')").run()).toThrow();
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
    db.prepare("INSERT INTO users (id, company_id, email, password, role, created_at) VALUES ('u1','c1','a@b.c','x','employee','2026-01-01')").run();
    expect(() => db.prepare("INSERT INTO expenses (id, company_id, user_id, status, created_at) VALUES ('e1','c1','u1','bogus','2026-01-01')").run()).toThrow();
  });
});
