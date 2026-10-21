describe('reports/draft-sweep', () => {
  let store, reports, users, sweep, db, u;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports'); sweep = require('./draft-sweep'); db = require('../db');
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
  });
  afterEach(() => sweep.stop());
  const HOUR = 60 * 60 * 1000;
  const aged = (r, hours, { touched = null } = {}) => db.prepare('UPDATE expense_reports SET created_at = ?, updated_at = ? WHERE id = ?')
    .run(new Date(Date.now() - hours * HOUR).toISOString(), touched === null ? null : new Date(Date.now() - touched * HOUR).toISOString(), r.id);
  const draft = () => reports.createReport({ companyId: u.companyId, userId: u.id, draft: true });
  const exists = r => !!reports.head(r.id);

  test('an empty draft older than a day goes; one with receipts, a young one, a touched one and a real case stay', () => {
    const empty = draft(); aged(empty, 25);
    const full = draft(); aged(full, 300);
    reports.addExpense(full.id, store.createExpense({ companyId: u.companyId, userId: u.id, status: 'reading' }).id);
    const young = draft(); aged(young, 23);
    const touched = draft(); aged(touched, 48, { touched: 2 });
    const open = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Open' }); aged(open, 500);
    expect(sweep.sweepDrafts()).toBe(1);
    expect([empty, full, young, touched, open].map(exists)).toEqual([false, true, true, true, true]);
    expect(sweep.sweepDrafts()).toBe(0);
    expect(sweep.sweepDrafts({ olderThanMs: HOUR })).toBe(2);           // the young one and the touched one, now
    expect([full, open].map(exists)).toEqual([true, true]);
  });

  test('start sweeps at once and then daily on a timer that does not hold the process open; stop ends it', () => {
    const empty = draft(); aged(empty, 30);
    const set = jest.spyOn(global, 'setInterval');
    sweep.start();
    expect(exists(empty)).toBe(false);
    expect(set).toHaveBeenCalledWith(expect.any(Function), sweep.DAY_MS);
    const timer = set.mock.results[0].value;
    expect(timer.hasRef()).toBe(false);
    sweep.start();                                                      // once is enough
    expect(set).toHaveBeenCalledTimes(1);
    sweep.stop();
    set.mockRestore();
  });

  test('a sweep that fails is logged, not thrown', () => {
    const warn = jest.spyOn(require('../utils/logger'), 'warn').mockImplementation(() => {});
    db.exec('ALTER TABLE expense_reports RENAME TO expense_reports_gone');
    try {
      expect(() => sweep.start()).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/drafts/), expect.any(Object));
    } finally { db.exec('ALTER TABLE expense_reports_gone RENAME TO expense_reports'); }
  });
});
