jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.0134, rateDate: '2026-09-04', providerDate: '2026-09-04', source: 'frankfurter', fetchedAt: 'x' }) }));

// The case's history as the Activity tab reads it: the events the case
// writes (and how a stretch of the same thing is one of them), and the feed
// that puts them together with the receipts' own logs.
describe('case activity', () => {
  let reports, store, users, edit, changes, activity, emp, admin;
  const T0 = Date.parse('2026-10-28T02:00:00.000Z');
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    reports = require('../store/reports'); store = require('../store/expenses'); users = require('../store/users');
    edit = require('../receipts/edit'); changes = require('../store/changes'); activity = require('./activity');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'Henry Admin' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, name: 'Aisha Rahman' });
  });
  afterEach(() => { jest.useRealTimers(); steps = 0; });
  const clock = (min = 0) => {
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    jest.setSystemTime(T0 + min * 60000);
  };
  const tick = min => jest.setSystemTime(T0 + min * 60000);
  // A second on for each thing done: two things in one millisecond have no order to show.
  let steps = 0;
  const step = () => jest.setSystemTime(T0 + (++steps) * 1000);
  const actor = u => ({ id: u.id, email: u.email, role: u.role, companyId: u.companyId });
  const open = (extra = {}) => reports.createReport({ companyId: emp.companyId, userId: emp.id, title: 'India trip', periodFrom: '2026-09-01', periodTo: '2026-09-04', kind: 'trip', ...extra });
  const seed = (r, extra = {}) => store.createExpense({ companyId: emp.companyId, userId: emp.id, reportId: r ? r.id : null, status: 'review-needed', merchant: 'Courtyard',
    currency: 'INR', total: 100, receiptDate: '2026-09-04', lines: [{ category: 'Lodging', amount: 100 }], ...extra });
  const events = r => reports.listEvents(r.id).map(ev => [ev.action, ev.note]);
  const feed = (r, opts) => activity.caseActivity(reports.getReport(r.id), opts);

  describe('the events a case writes', () => {
    test('details edits are one event per stretch of editing, listing the fields, kept up to date while the person types', () => {
      clock();
      const r = open();
      reports.updateReport(r.id, { title: 'I' }, { actorId: emp.id });
      tick(1); reports.updateReport(r.id, { title: 'India and Pune' }, { actorId: emp.id });
      tick(2); reports.updateReport(r.id, { periodTo: '2026-09-05', nights: 4 }, { actorId: emp.id });
      // the same values again is no edit, and moves nothing
      tick(3); reports.updateReport(r.id, { title: 'India and Pune', nights: 4 });
      expect(events(r)).toEqual([['created', null], ['details_edited', 'title, dates, nights']]);
      expect(reports.listEvents(r.id)[1].at).toBe(new Date(T0 + 2 * 60000).toISOString());
      expect(reports.listEvents(r.id)[1].actorId).toBe(emp.id);   // the owner, when the caller does not say
      // a quarter of an hour later is another stretch
      tick(2 + 16); reports.updateReport(r.id, { purpose: 'Client visits' }, { actorId: emp.id });
      // and so is anything that happened in between
      reports.addEvent(r.id, null, 'ai_details', 'Nights 4 → 5');
      reports.updateReport(r.id, { destination: 'Pune' }, { actorId: emp.id });
      // the assistant's proposal, applied, is said apart
      reports.updateReport(r.id, { notes: 'Two clients' }, { actorId: emp.id, via: 'assistant' });
      reports.updateReport(r.id, { advances: 50 }, { actorId: emp.id, via: 'assistant' });
      expect(events(r).slice(2)).toEqual([['details_edited', 'purpose'], ['ai_details', 'Nights 4 → 5'], ['details_edited', 'destination'],
        ['details_edited', 'advances, notes (via the assistant)']]);
    });

    test('a draft writes no edits while it is put together, its creation is two events, and the AI\'s writes are none', () => {
      const d = reports.createReport({ companyId: emp.companyId, userId: emp.id, draft: true });
      reports.updateReport(d.id, { title: 'India' }, { actorId: emp.id });
      reports.applyAutoCover(d.id, { destination: 'Pune' }, { auto: ['destination'], user: ['title'] });
      reports.openDraft(d.id, { purpose: 'Visits' }, emp.id);
      expect(events(d)).toEqual([['created', 'draft'], ['opened', null]]);
      reports.applyAutoCover(d.id, { nights: 3 }, { auto: ['destination', 'nights'], user: ['title', 'purpose'] });
      expect(events(d)).toHaveLength(2);
    });

    test('receipts checked one at a time are one `checked` event counting receipts, whatever the door; "check all" keeps its own', () => {
      clock();
      const r = open();
      const [a, b, c, d] = [seed(r), seed(r, { merchant: 'Uber' }), seed(r, { merchant: 'Taj' }), seed(r, { merchant: 'Grab' })];
      edit.setStatus(a.id, 'reviewed', actor(emp));
      tick(5); edit.setStatus(b.id, 'reviewed', actor(emp));
      // checked, unchecked and checked again is still one receipt
      tick(6); edit.setStatus(b.id, 'review-needed', actor(emp));
      tick(7); edit.setStatus(b.id, 'reviewed', actor(emp));
      tick(9); edit.setStatus(c.id, 'reviewed', actor(emp), { via: 'assistant' });
      expect(events(r)).toEqual([['created', null], ['checked', '3 receipts']]);
      // a receipt already checked is no check
      expect(() => edit.setStatus(c.id, 'reviewed', actor(emp))).not.toThrow();
      expect(events(r)[1][1]).toBe('3 receipts');
      // half an hour on is another run
      tick(45); edit.setStatus(d.id, 'reviewed', actor(emp));
      expect(events(r).slice(1)).toEqual([['checked', '3 receipts'], ['checked', '1 receipt']]);
      // the bulk route asks for none of its own per receipt
      edit.setStatus(d.id, 'review-needed', actor(emp));
      edit.setStatus(d.id, 'reviewed', actor(emp), { caseEvent: false });
      expect(events(r)).toHaveLength(3);
      // a receipt in no case has no case to tell
      const loose = seed(null);
      edit.setStatus(loose.id, 'reviewed', actor(emp));
      expect(events(r)).toHaveLength(3);
    });

    test('a receipt taken out of a case, or moved to another, is named in the case\'s history and in its own log', () => {
      const r = open(), other = open({ title: 'Mumbai' });
      const e = seed(r, { merchant: 'Grab Taxi', currency: 'SGD', total: 12.5, receiptDate: '2026-09-01' });
      edit.fileInCase(e.id, null, actor(emp));
      expect(events(r).pop()).toEqual(['removed', 'Grab Taxi, SGD 12.50, 1 Sep 2026']);
      expect(changes.list(e.id)[0]).toMatchObject({ field: 'case', oldValue: r.number, newValue: null });
      edit.fileInCase(e.id, r.id, actor(emp));
      edit.fileInCase(e.id, other.id, actor(emp));
      expect(events(r).pop()).toEqual(['removed', `Grab Taxi, SGD 12.50, 1 Sep 2026 (moved to ${other.number})`]);
      // filing in writes nothing on the case it went to: its own log says it
      expect(events(other)).toEqual([['created', null]]);
      // a duplicate stays where it is
      const dup = seed(r, { status: 'duplicate' });
      expect(() => edit.fileInCase(dup.id, null, actor(emp))).toThrow(/cannot be taken out of its case/);
    });
  });

  describe('the feed', () => {
    test('people, the AI and the system, each said in plain words, newest first', async () => {
      clock();
      const r = open();
      const e = seed(r, { merchant: 'Courtyard Pune', category: 'Lodging', currency: 'INR', total: 100 });
      tick(1); await edit.editDetails(e.id, { total: 120, category: 'Meals', receiptDate: '2026-09-03' }, actor(emp));
      tick(2); await edit.editDetails(e.id, { purpose: 'Client dinner' }, actor(admin), { via: 'assistant' });
      tick(3); edit.setStatus(e.id, 'reviewed', actor(emp));
      tick(4); reports.updateReport(r.id, { title: 'India and Pune', periodTo: '2026-09-05' }, { actorId: emp.id });
      tick(5); reports.addEvent(r.id, null, 'ai_details', 'Dates 1–4 Sep 2026 → 31 Aug – 4 Sep 2026; nights 3 → 4');
      tick(6); reports.addEvent(r.id, emp.id, 'xero_failed', 'The account code 400 is archived');
      tick(7); reports.addEvent(r.id, emp.id, 'edited', 'Mileage added: From Pune to Mumbai, 150 km × SGD 0.60');
      const { items, next } = feed(r);
      expect(next).toBeNull();
      // one save is one moment: the fields it changed, the line that follows
      // a new total, and the rate the new line was priced at
      const save = items.filter(x => x.at === new Date(T0 + 60000).toISOString());
      expect(items.map(x => [x.actor.type, x.action, x.text])).toEqual([
        ['person', 'mileage', 'Added mileage: From Pune to Mumbai, 150 km × SGD 0.60'],
        ['system', 'xero_failed', 'Xero refused the bill: The account code 400 is archived'],
        ['ai', 'ai_details', 'Updated the details from the receipts: Dates 1–4 Sep 2026 → 31 Aug – 4 Sep 2026; nights 3 → 4'],
        ['person', 'details_edited', 'Edited the details: title and dates'],
        ['person', 'checked', 'Checked 1 receipt'],
        ['person', 'edited', 'Edited Courtyard Pune: purpose set to Client dinner'],
        ...save.map(x => ['person', 'edited', x.text]),
        ['person', 'created', 'Created the case'],
      ]);
      expect(save.map(x => x.detail)).toEqual([
        'Exchange rate set to 0.0134 (European Central Bank)',
        'Lines (INR) Lodging 100.00 → Meals 120.00',
        'Category Lodging → Meals',
        'Total INR 100.00 → INR 120.00',
        'Date 4 Sep 2026 → 3 Sep 2026',
      ]);
      expect(save.find(x => x.field === 'total')).toMatchObject({ old: 'INR 100.00', new: 'INR 120.00', receiptId: e.id, merchant: 'Courtyard Pune', inCase: true });
      expect(save.find(x => x.field === 'receiptDate').text).toBe('Edited Courtyard Pune: date 4 Sep 2026 → 3 Sep 2026');
      // the admin, through the assistant, is a person, an admin, via the assistant
      expect(items[5].actor).toEqual({ type: 'person', id: admin.id, name: 'Henry Admin', role: 'admin', via: 'assistant' });
      expect(items[4].actor).toEqual({ type: 'person', id: emp.id, name: 'Aisha Rahman' });
      expect(items[3]).toMatchObject({ detail: 'Title and dates', note: 'title, dates' });
      // the check's own row is folded into the case's event, which names it
      expect(items[4].receipts).toEqual([{ id: e.id, merchant: 'Courtyard Pune', inCase: true }]);
      expect(items.filter(x => x.field === 'status')).toEqual([]);
    });

    test('a draft is said as started, then created; a run of checks names its receipts', () => {
      clock();
      const d = reports.createReport({ companyId: emp.companyId, userId: emp.id, draft: true });
      const a = seed(d, { merchant: 'Uber' }), b = seed(d, { merchant: 'Taj' });
      reports.openDraft(d.id, { title: 'Trip' }, emp.id);
      tick(1); edit.setStatus(a.id, 'reviewed', actor(emp));
      tick(3); edit.setStatus(b.id, 'reviewed', actor(emp));
      const items = feed(d).items;
      expect(items.map(x => x.text)).toEqual(['Checked 2 receipts', 'Created the case from the draft', 'Started a draft']);
      expect(items[0].receipts.map(x => x.merchant)).toEqual(['Uber', 'Taj']);
    });

    test('a receipt from My receipts comes in with its arrival, not its earlier life; one taken out keeps its time here', async () => {
      clock();
      step(); const r = open(), other = open({ title: 'Elsewhere' });
      step(); const loose = seed(null, { merchant: 'Grab' });
      step(); await edit.editDetails(loose.id, { total: 99 }, actor(emp));       // before it was in this case
      step(); edit.fileInCase(loose.id, r.id, actor(emp));
      step(); const moved = seed(other, { merchant: 'Uber' });
      step(); edit.fileInCase(moved.id, r.id, actor(emp));
      step(); const leaving = seed(r, { merchant: 'Taj' });
      step(); await edit.editDetails(leaving.id, { merchant: 'Taj Mahal' }, actor(emp));
      step(); edit.fileInCase(leaving.id, null, actor(emp));
      step(); await edit.editDetails(leaving.id, { purpose: 'After it left' }, actor(emp));   // not this case's business
      const items = feed(r).items;
      expect(items.map(x => x.text)).toEqual([
        'Took Taj Mahal, INR 100.00, 4 Sep 2026 out of the case',
        'Edited Taj Mahal: merchant Taj → Taj Mahal',
        `Moved Uber here from ${other.number}`,
        'Added Grab to the case',
        'Created the case',
      ]);
      // the removed event links to the receipt, which is no longer in the case
      expect(items[0]).toMatchObject({ action: 'removed', receiptId: leaving.id, merchant: 'Taj Mahal', inCase: false });
      expect(items[2]).toMatchObject({ action: 'moved_in', receiptId: moved.id, inCase: true });
      // the case it moved to says where it came from, by its own log
      expect(feed(other).items.map(x => x.text)).toEqual([`Moved Uber, INR 100.00, 4 Sep 2026 to ${r.number}`, 'Created the case']);
    });

    test('a receipt taken out before these events existed is still found, by the case\'s number', () => {
      clock();
      step(); const r = open();
      step(); const e = seed(r, { merchant: 'Old' });
      const before = store.getExpense(e.id);
      step(); reports.removeExpense(r.id, e.id);                       // the old way: no event
      step(); changes.record(before, store.getExpense(e.id), actor(emp));
      const items = feed(r).items;
      expect(items[0]).toMatchObject({ scope: 'receipt', action: 'taken_out', text: 'Took Old out of the case', receiptId: e.id, inCase: false });
    });

    test('an edit after the claim is said once, by the receipt\'s rows, marked as after the claim', async () => {
      clock();
      step(); const r = open();
      step(); const e = seed(r, { status: 'reviewed', lines: [{ category: 'Lodging', amount: 100, baseAmount: 1.34, fxRate: 0.0134, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }] });
      step(); require('./workflow').markClaimed(r.id, actor(emp));
      step(); await edit.editDetails(e.id, { invoiceNo: 'INV-7' }, actor(admin));
      expect(reports.listEvents(r.id).map(x => x.action)).toEqual(['created', 'claimed', 'edited']);
      const items = feed(r).items;
      expect(items.map(x => x.text)).toEqual(['Edited Courtyard: invoice no. set to INV-7, after the case was claimed', 'Marked the case claimed', 'Created the case']);
      expect(items[0]).toMatchObject({ afterClaim: true, actor: { type: 'person', role: 'admin', name: 'Henry Admin' } });
    });

    test('a receipt deleted, Xero\'s second bill, and an action nobody named yet each have words', () => {
      clock();
      step(); const r = open();
      step(); reports.addEvent(r.id, emp.id, 'deleted', 'Grab, SGD 9.00, 1 Sep 2026');
      step(); reports.addEvent(r.id, emp.id, 'posted', 'Xero bill abc-123');
      step(); reports.addEvent(r.id, emp.id, 'xero_failed', 'Xero also made bill x; the case keeps y. Delete the extra draft in Xero.');
      step(); reports.addEvent(r.id, null, 'something_new', 'a note');
      expect(feed(r).items.map(x => [x.actor.name, x.text])).toEqual([
        ['Solv', 'Something new: a note'],
        ['Xero', 'Xero also made bill x; the case keeps y. Delete the extra draft in Xero.'],
        ['Aisha Rahman', 'Posted to Xero: draft bill abc-123'],
        ['Aisha Rahman', 'Deleted Grab, SGD 9.00, 1 Sep 2026'],
        ['Aisha Rahman', 'Created the case'],
      ]);
    });

    test('the currency an amount was in is the one it had at the time', async () => {
      clock();
      step(); const r = open();
      step(); const e = seed(r, { currency: 'INR', total: 100 });
      step(); await edit.editDetails(e.id, { total: 110 }, actor(emp));
      step(); await edit.editDetails(e.id, { currency: 'SGD', total: 2 }, actor(emp));
      const totals = feed(r).items.filter(x => x.field === 'total').map(x => x.detail);
      expect(totals).toEqual(['Total INR 110.00 → SGD 2.00', 'Total INR 100.00 → INR 110.00']);
    });

    test('pages go back in time, and never end part-way through one save', async () => {
      clock();
      const r = open();
      const e = seed(r);
      for (let i = 1; i <= 4; i++) { tick(i * 20); await edit.editDetails(e.id, { total: 100 + i, invoiceNo: `N${i}` }, actor(emp)); }
      const all = feed(r).items;
      const first = feed(r, { limit: 2 });
      // two asked for, but the second's save had a third row in it
      expect(first.items).toHaveLength(3);
      expect(new Set(first.items.map(x => x.at)).size).toBe(1);
      const rest = feed(r, { before: first.next, limit: 100 });
      expect([...first.items, ...rest.items].map(x => x.id)).toEqual(all.map(x => x.id));
      expect(rest.next).toBeNull();
    });
  });
});
