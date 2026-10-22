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
    users.updateUser(e.id, { department: 'Sales', employeeId: 'S0001', name: 'Aisha' });
    const back = users.findById(e.id);
    expect(back.department).toBe('Sales');
    expect(back.employeeId).toBe('S0001');
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

  test('removing a person keeps the row and their records, and stops their password working', async () => {
    const admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    const e = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    const v = users.tokenVersion(e.id);
    users.removeUser(e.id);
    expect(users.findById(e.id)).toMatchObject({ removed: true });
    expect(users.tokenVersion(e.id)).toBe(v + 1);
    expect(await users.validatePassword('e@solv.sg', 'password123')).toBeNull();
    users.restoreUser(e.id);
    expect(await users.validatePassword('e@solv.sg', 'password123')).toMatchObject({ id: e.id });
  });

  test("each person's totals are their own", async () => {
    const admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    const e = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
    const store = require('./expenses');
    store.createExpense({ companyId: admin.companyId, userId: e.id, status: 'reviewed', currency: 'SGD', total: 10, lines: [{ category: 'Meals', amount: 10, baseAmount: 10 }] });
    const list = users.getAllUsers(admin.companyId);
    expect(list.find(u => u.id === e.id).totalCents).toBe(1000);
    expect(list.find(u => u.id === admin.id).totalCents).toBe(0);     // was the whole database's total
  });

  describe('the forwarding address', () => {
    afterEach(() => { delete process.env.INBOUND_EMAIL_DOMAIN; delete process.env.INBOUND_EMAIL_SECRET; });
    const on = () => { process.env.INBOUND_EMAIL_DOMAIN = 'In.Solv.sg'; process.env.INBOUND_EMAIL_SECRET = 'secret'; };

    test('there is none until the server takes mail, and nobody is given a token by asking then', async () => {
      const u = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
      expect(users.inboundConfigured()).toBe(false);
      expect(users.inboundAddress(u.id)).toBeNull();
      process.env.INBOUND_EMAIL_DOMAIN = 'in.solv.sg';               // the domain alone is not enough
      expect(users.inboundAddress(u.id)).toBeNull();
      expect(db.prepare('SELECT inbound_token FROM users WHERE id = ?').get(u.id).inbound_token).toBeNull();
    });

    test('made on first ask, the same after, and replaced on request; found by its token in any case', async () => {
      on();
      const a = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
      const b = await users.createUser({ email: 'b@solv.sg', password: 'password123', companyId: a.companyId });
      const first = users.inboundAddress(a.id);
      expect(first).toMatch(/^receipts\+[a-z2-7]{12}@in\.solv\.sg$/);
      expect(users.inboundAddress(a.id)).toBe(first);
      expect(users.inboundAddress(b.id)).not.toBe(first);
      const token = /\+([a-z0-9]+)@/.exec(first)[1];
      expect(users.findByInboundToken(token)).toMatchObject({ id: a.id, email: 'a@solv.sg' });
      expect(users.findByInboundToken(token.toUpperCase())).toMatchObject({ id: a.id });
      expect(users.findByInboundToken(token)).not.toHaveProperty('inboundToken');   // not handed about with the person

      const fresh = users.newInboundToken(a.id);
      expect(users.inboundAddress(a.id)).toBe(`receipts+${fresh}@in.solv.sg`);
      expect(users.findByInboundToken(token)).toBeNull();          // the old address stops working
      for (const bad of ['', null, 'short', 'has space here', 'x'.repeat(65)]) expect(users.findByInboundToken(bad)).toBeNull();
      expect(users.inboundAddress('nobody')).toBeNull();
    });

    test('one token is only ever one person\'s', async () => {
      const a = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
      const b = await users.createUser({ email: 'b@solv.sg', password: 'password123', companyId: a.companyId });
      db.prepare("UPDATE users SET inbound_token = 'abcdefghijkl' WHERE id = ?").run(a.id);
      expect(() => db.prepare("UPDATE users SET inbound_token = 'abcdefghijkl' WHERE id = ?").run(b.id)).toThrow(/UNIQUE/);
      // and any number of people may have none
      expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE inbound_token IS NULL').get().n).toBe(1);
    });

    test('the mail it took is counted over the last day', async () => {
      const a = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
      const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
      db.prepare('INSERT INTO inbound_mails (user_id, received_at) VALUES (?, ?)').run(a.id, old);
      users.recordInboundMail(a.id);
      users.recordInboundMail(a.id);
      expect(users.inboundMailsLastDay(a.id)).toBe(2);
      expect(db.prepare('SELECT COUNT(*) AS n FROM inbound_mails WHERE user_id = ?').get(a.id).n).toBe(2);   // the old row went
    });
  });
});
