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
