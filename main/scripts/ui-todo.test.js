const fs   = require('fs');
const path = require('path');

// What Home lists as waiting on a person, and where Home and My receipts open
// a receipt or a case (ui/src/utils/todo.js).
//
// Jest here runs CommonJS without a transform and the file is an ES module,
// so it is loaded from its source with its `export` keywords taken off. That
// only works while it imports nothing, which its header says.
function loadModule(file, names) {
  const src = fs.readFileSync(path.join(__dirname, '../../ui/src/utils', file), 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error(`${file} imports something now; this test can only load a module that does not`);
  const body = src.replace(/^export\s+(?=(function|const|let|class)\s)/gm, '');
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}

const T = loadModule('todo.js', ['casePath', 'receiptPath', 'readFailed', 'toCheck', 'nextStep', 'todoLinks', 'receiptName', 'receiptLabel', 'skippedText']);
const day = d => `day ${d}`;
const openCase = (id, x = {}) => ({ id, status: 'open', expenseCount: 3, unreviewed: 0, reading: 0, ready: false, ...x });

describe('where a receipt or a case opens', () => {
  test('a draft opens on the New case page, any other case on its own', () => {
    expect(T.casePath('c1', 'draft')).toBe('/reports/new?draft=c1');
    expect(T.casePath('c1', 'open')).toBe('/reports/c1');
    expect(T.casePath('c1', 'claimed')).toBe('/reports/c1');
  });

  test('a receipt in a case opens in that case\'s review, on itself', () => {
    expect(T.receiptPath({ id: 'e1', reportId: 'c1', reportStatus: 'open' })).toBe('/reports/c1/review?receipt=e1');
    expect(T.receiptPath({ id: 'e1', reportId: 'c1', reportStatus: 'claimed' })).toBe('/reports/c1/review?receipt=e1');
  });

  test('a receipt in a draft opens the draft, and one in no case its own page', () => {
    expect(T.receiptPath({ id: 'e1', reportId: 'c1', reportStatus: 'draft' })).toBe('/reports/new?draft=c1');
    expect(T.receiptPath({ id: 'e1', reportId: null })).toBe('/expenses/e1');
  });
});

describe('a read that failed', () => {
  test('is a receipt waiting for its owner with nothing read off it', () => {
    expect(T.readFailed({ status: 'review-needed', merchant: null, total: null, receiptDate: null, errorMsg: 'Reading was stopped.' })).toBe(true);
    expect(T.readFailed({ status: 'review-needed', merchant: null, total: 0, receiptDate: null })).toBe(true);
  });

  test('is not one with anything read, nor one still being read or checked', () => {
    expect(T.readFailed({ status: 'review-needed', merchant: 'Grab', total: null, receiptDate: null })).toBe(false);
    expect(T.readFailed({ status: 'review-needed', merchant: null, total: 12.5, receiptDate: null })).toBe(false);
    expect(T.readFailed({ status: 'review-needed', merchant: null, total: null, receiptDate: '2026-09-02' })).toBe(false);
    expect(T.readFailed({ status: 'reading', merchant: null, total: null, receiptDate: null })).toBe(false);
    expect(T.readFailed({ status: 'reviewed', merchant: null, total: null, receiptDate: null })).toBe(false);
  });
});

describe('the next step on a case', () => {
  test('receipts still being read are not counted as waiting to be checked', () => {
    expect(T.toCheck({ unreviewed: 5, reading: 2 })).toBe(3);
    expect(T.toCheck({ unreviewed: 2, reading: 2 })).toBe(0);
    expect(T.toCheck({})).toBe(0);
  });

  test('check what is waiting first, even while others are read', () => {
    expect(T.nextStep(openCase('c1', { unreviewed: 4, reading: 2 }))).toEqual({ kind: 'check', label: 'Check 2', to: '/reports/c1/review' });
  });

  test('then wait for the reader, then claim', () => {
    expect(T.nextStep(openCase('c1', { unreviewed: 2, reading: 2 }))).toMatchObject({ kind: 'reading', to: null });
    expect(T.nextStep(openCase('c1', { ready: true }))).toEqual({ kind: 'claim', label: 'Claim', to: '/reports/c1' });
  });

  test('an empty case asks for receipts; one waiting on a rate is opened', () => {
    expect(T.nextStep(openCase('c1', { expenseCount: 0 }))).toMatchObject({ kind: 'add', to: '/reports/c1' });
    expect(T.nextStep(openCase('c1', { ready: false }))).toMatchObject({ kind: 'open', to: '/reports/c1' });
  });
});

describe('Home\'s to-do links', () => {
  test('nothing waiting is no links at all', () => {
    expect(T.todoLinks({ cases: [openCase('c1')], failed: [] })).toEqual([]);
    expect(T.todoLinks()).toEqual([]);
  });

  test('receipts to check add up over the open cases and go to the list', () => {
    const links = T.todoLinks({ cases: [openCase('c1', { unreviewed: 2 }), openCase('c2', { unreviewed: 3, reading: 1 }), { ...openCase('d1', { unreviewed: 9 }), status: 'draft' }] });
    expect(links[0]).toEqual({ id: 'check', tone: 'warning', label: '4 to check', to: '/reports?status=open' });
  });

  test('a single thing waiting is opened straight away', () => {
    const links = T.todoLinks({
      cases: [openCase('c1', { unreviewed: 2 }), openCase('c2', { ready: true }), { id: 'd1', status: 'draft', expenseCount: 2, unreviewed: 2 }],
      failed: [{ id: 'e9', reportId: 'c1', reportStatus: 'open' }],
    });
    expect(links.map(l => [l.id, l.label, l.to])).toEqual([
      ['check', '2 to check', '/reports/c1/review'],
      ['failed', '1 read failed', '/reports/c1/review?receipt=e9'],
      ['draft', '1 draft', '/reports/new?draft=d1'],
      ['ready', '1 ready to claim', '/reports/c2'],
    ]);
  });

  test('several of a kind go to the list that holds them', () => {
    const links = T.todoLinks({
      cases: [openCase('c1', { ready: true }), openCase('c2', { ready: true }), { id: 'd1', status: 'draft' }, { id: 'd2', status: 'draft' }],
      failed: [{ id: 'e1' }, { id: 'e2' }],
    });
    expect(links.map(l => [l.id, l.label, l.to])).toEqual([
      ['failed', '2 reads failed', '/expenses?show=failed'],
      ['draft', '2 drafts', '/reports?status=draft'],
      ['ready', '2 ready to claim', '/reports?ready=1'],
    ]);
  });
});

describe('naming receipts the server refused', () => {
  test('each by its merchant and day, with the reason', () => {
    const rows = [{ id: 'a', merchant: 'Grab', receiptDate: '2026-09-02' }, { id: 'b', merchant: null, status: 'reading' }];
    expect(T.skippedText([{ id: 'a', why: 'a duplicate' }, { id: 'b', why: 'already in another case' }], rows, day))
      .toBe('Grab, day 2026-09-02 (a duplicate); a receipt still being read (already in another case)');
  });

  test('one with no merchant yet goes by the file it came from', () => {
    const rows = [{ id: 'a', merchant: null, status: 'review-needed', receipt: { originalName: 'IMG_2231.HEIC' } }];
    expect(T.skippedText([{ id: 'a', why: 'not found' }], rows, day)).toBe('IMG_2231.HEIC (not found)');
    expect(T.receiptName(rows[0])).toBe('IMG_2231.HEIC');
    expect(T.receiptName({ merchant: null, status: 'reading', receipt: { originalName: 'x.jpg' } })).toBe('Reading the receipt…');
    expect(T.receiptName({ merchant: null, status: 'review-needed' })).toBe('No merchant yet');
  });

  test('one no longer in the list is still named', () => {
    expect(T.skippedText([{ id: 'x', why: 'not found' }], [], day)).toBe('a receipt (not found)');
  });
});
