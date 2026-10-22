const fs   = require('fs');
const path = require('path');

// The decisions behind the Cases list and the case page
// (ui/src/components/cases/case-logic.js): how the list's filters live in the
// address, what a row offers to do next, and where a case is on its way.
//
// Jest here runs CommonJS without a transform and the file is an ES module,
// so it is loaded from its source with its `export` keywords taken off. That
// only works while it imports nothing, which its header says.
const SRC = path.join(__dirname, '../../ui/src/components/cases/case-logic.js');

function loadModule(names) {
  const src = fs.readFileSync(SRC, 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('case-logic.js imports something now; this test can only load a module that does not');
  const body = src.replace(/^export\s+(?=(async\s+function|function|const|let|class)\s)/gm, '');
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}

const L = loadModule(['PAGE_SIZE', 'readFilters', 'defaultChip', 'listQuery', 'withFilter', 'rowFacts', 'receiptsWords', 'caseHref',
  'rowAction', 'caseFacts', 'caseSteps', 'casePrimary', 'receiptState', 'onBehalfNames']);
const P = s => new URLSearchParams(s);
const qs = s => Object.fromEntries(new URLSearchParams(s));

describe('the list\'s filters in the address', () => {
  test('the links Home makes open the views they name', () => {
    expect(L.readFilters(P('status=open')).chip).toBe('open');
    expect(L.readFilters(P('ready=1')).chip).toBe('ready');
    expect(L.readFilters(P('status=draft')).chip).toBe('draft');
    const f = L.readFilters(P('scope=all&owner=u2'));
    expect(f).toMatchObject({ scope: 'all', owner: 'u2', chip: null });
  });

  test('nothing named, or nonsense, reads as no filter rather than an empty list', () => {
    expect(L.readFilters(P(''))).toEqual({ chip: null, kind: '', sort: 'newest', q: '', scope: 'mine', owner: '', page: 1 });
    expect(L.readFilters(P('status=pending&kind=boat&sort=up&page=-3'))).toEqual({ chip: null, kind: '', sort: 'newest', q: '', scope: 'mine', owner: '', page: 1 });
    // A claimant only means something across everyone's cases.
    expect(L.readFilters(P('owner=u2')).owner).toBe('');
  });

  test('the default chip is Open while there is an open case, else All', () => {
    expect(L.defaultChip(null)).toBe('open');
    expect(L.defaultChip({ open: 3, all: 5 })).toBe('open');
    expect(L.defaultChip({ open: 0, all: 5 })).toBe('all');
  });

  test('the server is asked for one page of exactly the chosen filters', () => {
    const f = L.readFilters(P('kind=trip&q=taxi&sort=amount&page=3'));
    expect(qs(L.listQuery(f, 'open'))).toEqual({ status: 'open', kind: 'trip', q: 'taxi', sort: 'amount', limit: '20', offset: '40' });
    expect(qs(L.listQuery(L.readFilters(P('')), 'ready'))).toEqual({ ready: '1', limit: '20', offset: '0' });
    expect(qs(L.listQuery(L.readFilters(P('')), 'all'))).toEqual({ limit: '20', offset: '0' });
  });

  test('everyone\'s cases are asked for only by an admin', () => {
    const f = L.readFilters(P('scope=all&owner=u2'));
    expect(qs(L.listQuery(f, 'all', { canAll: true }))).toMatchObject({ scope: 'all', owner: 'u2' });
    expect(qs(L.listQuery(f, 'all', { canAll: false }))).not.toHaveProperty('scope');
  });

  test('a new filter starts at page 1; the page alone keeps the rest', () => {
    const at = P('status=open&kind=trip&page=3');
    expect(qs(L.withFilter(at, { kind: 'period' }))).toEqual({ status: 'open', kind: 'period' });
    expect(qs(L.withFilter(at, { page: 4 }))).toEqual({ status: 'open', kind: 'trip', page: '4' });
    expect(qs(L.withFilter(at, { page: 1 }))).toEqual({ status: 'open', kind: 'trip' });
  });

  test('chips write the address Home links to, and defaults are left out', () => {
    expect(qs(L.withFilter(P('status=open'), { chip: 'ready' }))).toEqual({ ready: '1' });
    expect(qs(L.withFilter(P('ready=1'), { chip: 'draft' }))).toEqual({ status: 'draft' });
    expect(qs(L.withFilter(P('status=open&sort=amount'), { sort: 'newest', q: '  ' }))).toEqual({ status: 'open' });
    expect(qs(L.withFilter(P('scope=all&owner=u2'), { scope: 'mine' }))).toEqual({});
    // ?new=1 is not carried along once anything is chosen.
    expect(qs(L.withFilter(P('new=1'), { chip: 'all' }))).toEqual({ status: 'all' });
  });
});

describe('a row of the list', () => {
  const row = over => ({ id: 'r1', userId: 'me', status: 'open', expenseCount: 4, unreviewed: 0, reading: 0, ready: true, ...over });

  test('receipts read as how many are left, or all checked', () => {
    expect(L.receiptsWords(row({ expenseCount: 15, unreviewed: 2 }))).toBe('2 to check');
    expect(L.receiptsWords(row({ expenseCount: 3, unreviewed: 3, reading: 3 }))).toBe('3 reading');
    expect(L.receiptsWords(row({ expenseCount: 5, unreviewed: 3, reading: 1 }))).toBe('1 reading, 2 to check');
    expect(L.receiptsWords(row({}))).toBe('all checked');
    expect(L.receiptsWords(row({ expenseCount: 0 }))).toBe('');
  });

  test('one next step, by where the case stands', () => {
    expect(L.rowAction(row({ status: 'draft' }), 'me')).toMatchObject({ label: 'Continue', to: '/reports/new?draft=r1' });
    expect(L.rowAction(row({ unreviewed: 2, ready: false }), 'me')).toMatchObject({ label: 'Check 2', to: '/reports/r1/review' });
    expect(L.rowAction(row({ unreviewed: 3, reading: 3, ready: false }), 'me')).toBeNull();
    expect(L.rowAction(row({}), 'me')).toMatchObject({ label: 'Claim', to: '/reports/r1' });
    expect(L.rowAction(row({ expenseCount: 0, ready: false }), 'me')).toMatchObject({ id: 'add' });
    // Checked but waiting for a rate: nothing to press yet.
    expect(L.rowAction(row({ ready: false }), 'me')).toBeNull();
    expect(L.rowAction(row({ status: 'claimed', ready: false }), 'me')).toBeNull();
  });

  test('never a button on somebody else\'s case', () => {
    expect(L.rowAction(row({ userId: 'them', unreviewed: 2 }), 'me')).toBeNull();
    expect(L.rowAction(row({ userId: 'them', status: 'draft' }), 'me')).toBeNull();
  });

  test('a draft opens where it was being put together, for its owner only', () => {
    expect(L.caseHref(row({ status: 'draft' }), 'me')).toBe('/reports/new?draft=r1');
    expect(L.caseHref(row({ status: 'draft', userId: 'them' }), 'me')).toBe('/reports/r1');
    expect(L.caseHref(row({}), 'me')).toBe('/reports/r1');
  });
});

describe('where a case is on its way', () => {
  const ex = (status, n = 1) => Array.from({ length: n }, (_, i) => ({ id: `${status}${i}`, status, lines: [{}] }));
  const report = (expenses, over = {}) => ({ id: 'c1', status: 'open', expenses, totals: { pendingRates: 0, noAmount: 0 }, ...over });
  const states = r => L.caseSteps(r).map(s => s.state);

  test('an empty case is at Receipts', () => {
    expect(states(report([]))).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(L.casePrimary(report([]), { isOwner: true })).toMatchObject({ id: 'add' });
  });

  test('receipts being read keep it at Receipts, and the read ones can be checked meanwhile', () => {
    const r = report([...ex('reading', 2), ...ex('review-needed')], { totals: { pendingRates: 0, noAmount: 2 } });
    expect(states(r)).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(L.caseSteps(r)[0].hint).toBe('2 reading');
    expect(L.casePrimary(r, { isOwner: true })).toMatchObject({ id: 'check', label: 'Check 1 receipt', to: '/reports/c1/review' });
    expect(L.caseFacts(r)).toMatchObject({ reading: 2, toCheck: 1, noAmount: 0, ready: false });
  });

  test('read and waiting is at Check', () => {
    const r = report([...ex('reviewed', 13), ...ex('review-needed', 2)]);
    expect(states(r)).toEqual(['done', 'current', 'todo', 'todo']);
    expect(L.caseSteps(r)[1].hint).toBe('2 left');
  });

  test('all checked and priced is ready to claim', () => {
    const r = report(ex('reviewed', 4));
    expect(states(r)).toEqual(['done', 'done', 'current', 'todo']);
    expect(L.caseFacts(r).ready).toBe(true);
    expect(L.casePrimary(r, { isOwner: true })).toMatchObject({ id: 'claim' });
  });

  test('checked but waiting for a rate is not ready, and offers no button', () => {
    const r = report(ex('reviewed', 2), { totals: { pendingRates: 1, noAmount: 0 } });
    expect(L.caseFacts(r).ready).toBe(false);
    expect(L.caseSteps(r)[2].hint).toBe('not priced yet');
    expect(L.casePrimary(r, { isOwner: true })).toBeNull();
  });

  test('claimed is at Xero; posting is offered only with Xero connected', () => {
    const r = report(ex('reviewed', 2), { status: 'claimed' });
    expect(states(r)).toEqual(['done', 'done', 'done', 'current']);
    expect(L.casePrimary(r, { isOwner: true, xeroConnected: true })).toMatchObject({ id: 'post' });
    expect(L.casePrimary(r, { isOwner: true, xeroConnected: false })).toBeNull();
    expect(L.caseSteps(r, { xeroConnected: false })[3].hint).toBe('not connected');
    expect(L.caseSteps(r, { posted: true }).map(s => s.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(L.casePrimary(r, { isOwner: true, posted: true, xeroConnected: true })).toBeNull();
  });

  test('nobody but the owner gets the button', () => {
    expect(L.casePrimary(report(ex('review-needed')), { isOwner: false })).toBeNull();
    expect(L.casePrimary(report(ex('reviewed')), { isOwner: false })).toBeNull();
  });

  test('a receipt\'s state for the table', () => {
    expect(['reviewed', 'reading', 'duplicate', 'review-needed', 'rejected'].map(s => L.receiptState({ status: s })))
      .toEqual(['checked', 'reading', 'duplicate', 'check', 'check']);
  });

  test('who a cost was paid for is named once', () => {
    const list = [{ lines: [{ onBehalfOf: 'Henry' }, { onBehalfOf: 'Henry' }] }, { lines: [{ onBehalfOf: 'Ana' }] }, {}];
    expect(L.onBehalfNames(list)).toEqual(['Henry', 'Ana']);
  });
});
