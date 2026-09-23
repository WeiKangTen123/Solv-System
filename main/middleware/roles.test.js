const { requireRole, canAccessUser } = require('./roles');

describe('middleware/roles', () => {
  const res = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };

  test('requireRole passes a listed role and refuses others with 403', () => {
    const next = jest.fn(); const r = res();
    requireRole('admin')({ user: { role: 'admin' } }, r, next);
    expect(next).toHaveBeenCalled();
    const r2 = res(); const next2 = jest.fn();
    requireRole('admin')({ user: { role: 'user' } }, r2, next2);
    expect(r2.status).toHaveBeenCalledWith(403);
    expect(next2).not.toHaveBeenCalled();
  });

  // Two roles. A user sees their own; an admin sees the company. There is no
  // "manager over a direct report" any more because nobody has a manager.
  test('canAccessUser: self, or an admin over anyone', () => {
    expect(canAccessUser({ id: 'u1', role: 'user' }, 'u1')).toBe(true);
    expect(canAccessUser({ id: 'u2', role: 'user' }, 'u1')).toBe(false);
    expect(canAccessUser({ id: 'a1', role: 'admin' }, 'u1')).toBe(true);
    expect(canAccessUser(null, 'u1')).toBe(false);
    expect(canAccessUser({ id: 'u1', role: 'user' }, null)).toBe(false);
  });
});
