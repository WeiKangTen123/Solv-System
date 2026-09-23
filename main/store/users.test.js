describe('store/users', () => {
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

  test('later accounts join the same company as users unless a role is given', async () => {
    const admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    const e = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    const a2 = await users.createUser({ email: 'a2@solv.sg', password: 'password123', companyId: admin.companyId, role: 'admin' });
    expect(e.role).toBe('user');
    expect(a2.role).toBe('admin');
    expect(e.companyId).toBe(admin.companyId);
    await expect(users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: admin.companyId, role: 'manager' })).rejects.toThrow(/Unknown role/);
  });

  test('profile fields update and read back; sanitize never leaks the hash', async () => {
    const admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    const e = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    users.updateUser(e.id, { department: 'Sales', employeeId: 'S0042', name: 'Elaine' });
    const back = users.findById(e.id);
    expect(back.department).toBe('Sales');
    expect(back.employeeId).toBe('S0042');
    expect(back.password).toBeUndefined();
    expect(back.managerId).toBeUndefined();          // nobody reports to anybody
    expect(() => users.updateUser(e.id, { role: 'finance' })).toThrow(/Unknown role/);
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
