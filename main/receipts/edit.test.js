jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.0134, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: 'x' }) }));

describe('receipts/edit', () => {
  let edit, users, store, changes, admin, emp;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    edit = require('./edit'); users = require('../store/users'); store = require('../store/expenses'); changes = require('../store/changes');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId });
  });
  const actor = u => ({ id: u.id, email: u.email, role: u.role, companyId: u.companyId });
  const seed = () => store.createExpense({ companyId: emp.companyId, userId: emp.id, status: 'review-needed', merchant: 'Courtyard', currency: 'INR',
    total: 100, receiptDate: '2026-09-04', lines: [{ category: 'Lodging', amount: 100 }] });

  test('cleanPatch keeps known fields, trims text, and refuses what a receipt cannot say', () => {
    expect(edit.cleanPatch({ merchant: '  Courtyard  ', total: '12.50', unknown: 'x', currency: 'inr' }))
      .toEqual({ merchant: 'Courtyard', total: 12.5, currency: 'INR' });
    expect(edit.cleanPatch({ purpose: '' })).toEqual({ purpose: null });
    expect(edit.cleanPatch({ merchant: 'x'.repeat(500) }).merchant).toHaveLength(120);
    expect(() => edit.cleanPatch({ merchant: { $gt: '' } })).toThrow(/a value/);
    expect(() => edit.cleanPatch({ total: -1 })).toThrow(/number/);
    expect(() => edit.cleanPatch({ total: 1e12 })).toThrow(/number/);
    expect(() => edit.cleanPatch({ total: 'abc' })).toThrow(/number/);
    expect(() => edit.cleanPatch({ receiptDate: '2026-02-30' })).toThrow(/real/);
    expect(() => edit.cleanPatch({ receiptDate: '2999-01-01' })).toThrow(/future/);
    expect(() => edit.cleanPatch({ currency: 'rupees' })).toThrow(/3-letter/);
    expect(() => edit.cleanPatch({ category: 'Bribes' })).toThrow(/Unknown category/);
    expect(edit.cleanPatch({ category: 'lodging' }).category).toBe('Lodging');
  });

  test('every edit is logged with who made it and which door it came through', async () => {
    const e = seed();
    await edit.editDetails(e.id, { merchant: 'Courtyard Pune' }, actor(emp));
    await edit.editDetails(e.id, { tax: 5 }, actor(admin), { via: 'assistant' });
    await edit.editLines(e.id, [{ category: 'Lodging', amount: 60 }, { category: 'Meals', amount: 40, onBehalfOf: 'Tan' }], actor(emp), { via: 'assistant' });
    const log = changes.list(e.id);
    // The new lines were priced as a consequence, and that is logged too.
    expect(log.map(c => [c.field, c.actorRole, c.via])).toEqual([
      ['rate', 'owner', 'assistant'],
      ['lines', 'owner', 'assistant'],
      ['tax', 'admin', 'assistant'],
      ['merchant', 'owner', 'app'],
    ]);
    expect(log[1].newValue).toBe('Lodging 60.00 · Meals 40.00 (Tan)');
  });

  test('a category set on a one-line receipt reaches its line, which the report reads', async () => {
    const e = seed();
    const after = await edit.editDetails(e.id, { category: 'Meals' }, actor(admin));
    expect(after.category).toBe('Meals');
    expect(after.lines).toEqual([expect.objectContaining({ category: 'Meals', amount: 100 })]);
    expect(changes.list(e.id).map(c => c.field).sort()).toEqual(['category', 'lines']);
  });

  test('a typed rate and a refresh are logged as rate changes', async () => {
    const e = seed();
    await edit.setRate(e.id, { rate: 0.0136, reason: 'Card statement' }, actor(emp));
    await edit.refreshRate(e.id, actor(admin));
    const rates = changes.list(e.id).filter(c => c.field === 'rate');
    expect(rates[1]).toMatchObject({ newValue: '0.0136 typed: Card statement', actorRole: 'owner' });
    expect(rates[0]).toMatchObject({ oldValue: '0.0136 typed: Card statement', newValue: '0.0134 frankfurter', actorRole: 'admin' });
  });

  test('a claimant typing a rate far from the day is held to 5%; an admin is not', async () => {
    const e = seed();
    await expect(edit.setRate(e.id, { rate: 0.02, reason: 'x' }, actor(emp))).rejects.toMatchObject({ status: 400 });
    await expect(edit.setRate(e.id, { rate: 0.02, reason: 'Bank rate' }, actor(admin))).resolves.toBeTruthy();
  });

  test('lines must be real: a list, positive, bounded, and adding up', async () => {
    const e = seed();
    await expect(edit.editLines(e.id, 'x', actor(emp))).rejects.toMatchObject({ status: 400 });
    await expect(edit.editLines(e.id, [null], actor(emp))).rejects.toMatchObject({ status: 400 });
    await expect(edit.editLines(e.id, [{ amount: 50 }], actor(emp))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/total/) });
    await expect(edit.editLines(e.id, Array.from({ length: 101 }, () => ({ amount: 1 })), actor(emp))).rejects.toMatchObject({ status: 400 });
    expect(changes.list(e.id)).toHaveLength(0);
  });

  test('a stranger, a duplicate and a posted case are each refused with their own answer', async () => {
    const stranger = await users.createUser({ email: 's@solv.sg', password: 'password123', companyId: admin.companyId });
    const e = seed();
    await expect(edit.editDetails(e.id, { merchant: 'x' }, actor(stranger))).rejects.toMatchObject({ status: 404 });
    const dup = store.createExpense({ companyId: emp.companyId, userId: emp.id, status: 'duplicate', total: 1 });
    await expect(edit.editDetails(dup.id, { merchant: 'x' }, actor(emp))).rejects.toMatchObject({ status: 400 });
    const reports = require('../store/reports');
    const r = reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'T' });
    reports.addExpense(r.id, e.id);
    require('../db').prepare("UPDATE expense_reports SET status = 'claimed', xero_invoice_id = 'inv' WHERE id = ?").run(r.id);
    await expect(edit.editDetails(e.id, { merchant: 'x' }, actor(admin))).rejects.toMatchObject({ status: 409 });
    expect(edit.permissions(store.getExpense(e.id), actor(emp))).toEqual({ isOwner: true, canEditDetails: false, canAct: false, posted: true });
  });
});
