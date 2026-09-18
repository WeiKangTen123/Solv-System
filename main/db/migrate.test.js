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

  test('expenses reject an unknown status', () => {
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('c1', 'Solv', '2026-01-01')").run();
    db.prepare("INSERT INTO users (id, company_id, email, password, role, created_at) VALUES ('u1','c1','a@b.c','x','employee','2026-01-01')").run();
    expect(() => db.prepare("INSERT INTO expenses (id, company_id, user_id, status, created_at) VALUES ('e1','c1','u1','bogus','2026-01-01')").run()).toThrow();
  });
});
