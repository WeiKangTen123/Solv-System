const fs   = require('fs');
const path = require('path');

// The decisions behind the New case page's intake panel
// (ui/src/components/intake/intake-logic.js) and how a receipt file is sent
// (ui/src/components/receipts/receipt-upload.js): which route a dropped file
// goes to, what a row counts as, how the page's rows and the server's files
// line up, and when the panel asks again.
//
// Jest here runs CommonJS without a transform, and both files are ES modules,
// so each is loaded from its source with its `export` keywords taken off.
// That only works while they import nothing, which their headers say.
const UI = path.join(__dirname, '../../ui/src/components');

function loadModule(file, names) {
  const src = fs.readFileSync(path.join(UI, file), 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error(`${file} imports something now; this test can only load a module that does not`);
  const body = src.replace(/^export\s+(?=(async\s+function|function|const|let|class)\s)/gm, '');
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}

const L = loadModule('intake/intake-logic.js', ['kindOf', 'planDrop', 'fmtClock', 'fmtEta', 'waitingRetry', 'bucketOf', 'countRows', 'countsLine', 'mergeRows', 'pollEvery', 'isDoneClaim', 'hasAmount', 'ZIP_MAX_BYTES']);
const U = loadModule('receipts/receipt-upload.js', ['declaredMime', 'serverConverts', 'ACCEPT_ATTR', 'PHOTO_ACCEPT_ATTR']);

const MB = 1024 * 1024;
const file = (name, { type = '', size = 1000 } = {}) => ({ name, type, size });
const NOW = Date.parse('2026-10-21T10:00:00Z');
const iso = ms => new Date(ms).toISOString();

describe('what a dropped file is', () => {
  test('photos, PDFs and the formats the server converts are receipts, with or without a type', () => {
    for (const n of ['a.jpg', 'b.JPEG', 'c.png', 'd.pdf', 'e.heic', 'f.HEIF', 'g.tif', 'h.tiff', 'i.avif', 'j.webp', 'k.gif', 'l.bmp']) {
      expect(L.kindOf(file(n)).kind).toBe('receipt');
    }
    expect(L.kindOf(file('scan', { type: 'image/png' })).kind).toBe('receipt');
    // No type and no extension: the browser finds out when it draws it.
    expect(L.kindOf(file('photo')).kind).toBe('receipt');
  });

  test('a zip and an .xlsx are told apart from receipts', () => {
    expect(L.kindOf(file('receipts.zip')).kind).toBe('zip');
    expect(L.kindOf(file('x', { type: 'application/x-zip-compressed' })).kind).toBe('zip');
    expect(L.kindOf(file('claim.xlsx')).kind).toBe('form');
  });

  test('what cannot be a receipt is refused here, saying why', () => {
    expect(L.kindOf(file('claim.xls'))).toEqual({ kind: 'refused', why: expect.stringMatching(/save it as \.xlsx/) });
    expect(L.kindOf(file('mail.eml')).why).toMatch(/Emails are not read yet/);
    expect(L.kindOf(file('notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).why).toMatch(/^Not a receipt file\. Accepted:/);
    expect(L.kindOf(file('empty.jpg', { size: 0 })).why).toMatch(/empty/);
  });
});

describe('planDrop: where each file of a drop goes', () => {
  test('receipts on their own, zips unpacked one by one', () => {
    const p = L.planDrop([file('a.jpg'), file('r.zip'), file('b.pdf'), file('s.zip'), file('x.txt', { type: 'text/plain' })]);
    expect(p.receipts.map(f => f.name)).toEqual(['a.jpg', 'b.pdf']);
    expect(p.zips.map(f => f.name)).toEqual(['r.zip', 's.zip']);
    expect(p.claim).toBeNull();
    expect(p.refused.map(r => [r.file.name, r.state])).toEqual([['x.txt', 'unsupported']]);
  });

  test('a claim form makes the drop a claim, with every zip in it', () => {
    const p = L.planDrop([file('a.jpg'), file('r.zip'), file('claim.xlsx')]);
    expect(p.claim.forms.map(f => f.name)).toEqual(['claim.xlsx']);
    expect(p.claim.archives.map(f => f.name)).toEqual(['r.zip']);
    expect(p.zips).toEqual([]);
    expect(p.receipts.map(f => f.name)).toEqual(['a.jpg']);
  });

  test('an .xlsx alone is a claim', () => {
    expect(L.planDrop([file('claim.xlsx')]).claim).toEqual({ archives: [], forms: [expect.objectContaining({ name: 'claim.xlsx' })] });
  });

  test('a zip over the limit is refused before it is sent, as is a claim over the import\'s', () => {
    const big = L.planDrop([file('big.zip', { size: L.ZIP_MAX_BYTES + 1 })]);
    expect(big.zips).toEqual([]);
    expect(big.refused[0]).toEqual(expect.objectContaining({ state: 'too-big', why: expect.stringMatching(/up to 18\.0 MB/) }));
    const claim = L.planDrop([file('big.zip', { size: 12 * MB }), file('claim.xlsx', { size: 7 * MB })]);
    expect(claim.claim).toBeNull();
    expect(claim.refused.map(r => r.state)).toEqual(['too-big', 'too-big']);
  });
});

describe('hasAmount', () => {
  test('a read that made nothing out (total 0, flagged no-amount) has no amount; a real 0 or more does', () => {
    expect(L.hasAmount({ total: 0, flags: [{ code: 'no-amount', level: 'red' }] })).toBe(false);
    expect(L.hasAmount({ total: null, flags: [] })).toBe(false);
    expect(L.hasAmount({ total: 12.5, flags: [{ code: 'no-date', level: 'red' }] })).toBe(true);
    expect(L.hasAmount({ total: 0, flags: [] })).toBe(true);
    // Still being read: the 0 and the currency are placeholders, not a read.
    expect(L.hasAmount({ status: 'reading', total: 0, currency: 'SGD', flags: [] })).toBe(false);
  });
});

describe('the words for a wait', () => {
  test('a countdown', () => {
    expect(L.fmtClock(40 * 1000)).toBe('0:40');
    expect(L.fmtClock(12 * 60 * 1000 + 5000)).toBe('12:05');
    expect(L.fmtClock(-5)).toBe('0:00');
  });
  test('the time left, said as a person would', () => {
    expect(L.fmtEta(0)).toBe('');
    expect(L.fmtEta(30)).toBe('less than a minute left');
    expect(L.fmtEta(70)).toBe('about 1 min left');
    expect(L.fmtEta(300)).toBe('about 5 min left');
  });
});

describe('what a row counts as', () => {
  const read = (state, extra = {}) => ({ state, attempts: 0, nextAt: iso(NOW - 1000), errorKind: null, error: null, ...extra });
  const grab = { id: 'e1', status: 'review-needed', merchant: 'Grab', total: 12, flags: [] };
  const served = (r, expenses = [grab]) => ({ local: null, file: { receiptId: 'r1', read: r, expenses } });

  test('the server\'s states', () => {
    expect(L.bucketOf(served(read('queued')), NOW)).toBe('reading');
    expect(L.bucketOf(served(read('reading')), NOW)).toBe('reading');
    expect(L.bucketOf(served(read('done')), NOW)).toBe('read');
    expect(L.bucketOf(served(null), NOW)).toBe('read');
    expect(L.bucketOf(served(read('failed')), NOW)).toBe('needYou');
    expect(L.bucketOf(served(read('cancelled')), NOW)).toBe('needYou');
    expect(L.bucketOf(served(read('done'), [{ ...grab, status: 'duplicate' }]), NOW)).toBe('needYou');
  });

  test('a read that made nothing out of any receipt in the file needs the person', () => {
    const blank = { id: 'e2', status: 'review-needed', merchant: null, total: 0, flags: [{ code: 'no-amount', level: 'red' }] };
    expect(L.bucketOf(served(read('done'), [blank]), NOW)).toBe('needYou');
    expect(L.bucketOf(served(read('done'), [blank, grab]), NOW)).toBe('read');
  });

  test('a read put off because the AI was busy is waiting, until it is due', () => {
    const later = read('queued', { errorKind: 'unavailable', nextAt: iso(NOW + 40000) });
    expect(L.waitingRetry(later, NOW)).toBe(true);
    expect(L.bucketOf(served(later), NOW)).toBe('waiting');
    expect(L.bucketOf(served(later), NOW + 41000)).toBe('reading');
    // A fresh job is due now and has no error: it is simply queued.
    expect(L.waitingRetry(read('queued'), NOW)).toBe(false);
  });

  test('the page\'s own rows', () => {
    const local = (state, extra) => ({ local: { id: 'u1', kind: 'receipt', state, ...extra }, file: null });
    for (const s of ['queued', 'preparing', 'uploading']) expect(L.bucketOf(local(s), NOW)).toBe('uploading');
    expect(L.bucketOf(local('stored'), NOW)).toBe('reading');
    for (const s of ['duplicate', 'unsupported', 'too-big', 'failed']) expect(L.bucketOf(local(s), NOW)).toBe('needYou');
    expect(L.bucketOf(local('claim', { kind: 'claim', job: { stage: 'reading receipts' } }), NOW)).toBe('reading');
    expect(L.bucketOf(local('claim', { kind: 'claim', job: { stage: 'failed' } }), NOW)).toBe('needYou');
  });

  test('the counts line leaves out what is empty, and a finished claim import is not counted twice', () => {
    const rows = [
      served(read('done')), served(read('done')), served(read('reading')),
      { local: { id: 'u1', state: 'uploading' }, file: null },
      { local: { id: 'u2', state: 'duplicate' }, file: null },
      { local: { id: 'u3', kind: 'claim', state: 'claim', job: { stage: 'done' } }, file: null },
    ];
    expect(L.isDoneClaim(rows[5])).toBe(true);
    const c = L.countRows(rows, NOW);
    expect(c).toEqual({ files: 5, uploading: 1, reading: 1, waiting: 0, read: 2, needYou: 1 });
    expect(L.countsLine(c)).toBe('5 files: 2 read, 1 uploading, 1 to be read, 1 needs you');
    expect(L.countsLine({ files: 1, read: 1 })).toBe('1 file: 1 read');
    expect(L.countsLine({ files: 0 })).toBe('');
  });
});

describe('mergeRows: the page\'s rows and the server\'s files as one list', () => {
  const f = (receiptId, receivedAt) => ({ receiptId, receivedAt, read: null, expenses: [] });

  test('the server\'s files first, each with the row it was sent from; then what the page still holds', () => {
    const local = [
      { id: 'a', state: 'stored', receiptId: 'r2', storedAt: NOW - 5000 },
      { id: 'b', state: 'uploading' },
      { id: 'c', state: 'duplicate', dupOf: 'r1' },
    ];
    const out = L.mergeRows(local, [f('r1'), f('r2')], { polledAt: NOW });
    expect(out.map(r => r.key)).toEqual(['r:r1', 'l:a', 'l:b', 'l:c']);
    expect(out[1].file.receiptId).toBe('r2');
    expect(out[1].local.id).toBe('a');
  });

  test('a file just stored and not yet in an answer is shown; one missing from a later answer has left the case', () => {
    const local = [{ id: 'a', state: 'stored', receiptId: 'r9', storedAt: NOW }];
    expect(L.mergeRows(local, [], { polledAt: NOW - 1000 }).map(r => r.key)).toEqual(['l:a']);
    expect(L.mergeRows(local, [], { polledAt: NOW + 1000 })).toEqual([]);
  });
});

describe('pollEvery: when the panel asks again', () => {
  const job = (state, nextAt) => ({ receiptId: 'r', read: { state, nextAt: iso(nextAt) }, expenses: [] });
  test('every 2 s while a file is on its way or a read is running or due', () => {
    expect(L.pollEvery({ uploading: 1, files: [] }, NOW)).toBe(2000);
    expect(L.pollEvery({ files: [job('reading', NOW)] }, NOW)).toBe(2000);
    expect(L.pollEvery({ files: [job('queued', NOW - 1)] }, NOW)).toBe(2000);
  });
  test('when the soonest put-off read is due, but at least every 20 s', () => {
    expect(L.pollEvery({ files: [job('queued', NOW + 7000)] }, NOW)).toBe(7000);
    expect(L.pollEvery({ files: [job('queued', NOW + 3600 * 1000)] }, NOW)).toBe(20000);
    expect(L.pollEvery({ files: [job('done', NOW)] }, NOW)).toBe(20000);
  });
});

describe('receipt-upload: what a file is sent as', () => {
  test('the declared type, or the extension\'s when the browser gave none', () => {
    expect(U.declaredMime(file('IMG_1.HEIC'))).toBe('image/heic');
    expect(U.declaredMime(file('scan.tif', { type: 'application/octet-stream' }))).toBe('image/tiff');
    expect(U.declaredMime(file('a.jpg', { type: 'image/jpg' }))).toBe('image/jpeg');
    expect(U.declaredMime(file('a.png', { type: 'image/png' }))).toBe('image/png');
    expect(U.declaredMime(file('mystery'))).toBe('');
  });

  test('HEIC, HEIF, TIFF and AVIF may go as they are, for the server to convert', () => {
    for (const n of ['a.heic', 'a.heif', 'a.tif', 'a.tiff', 'a.avif']) expect(U.serverConverts(file(n))).toBe(true);
    for (const n of ['a.jpg', 'a.webp', 'a.bmp', 'a.pdf']) expect(U.serverConverts(file(n))).toBe(false);
  });

  test('the picker offers the formats by extension too, and a zip and a claim form; the phone\'s does not', () => {
    for (const x of ['.heic', '.heif', '.tif', '.tiff', '.avif', '.webp', '.gif', '.bmp', '.pdf', '.zip', '.xlsx', 'image/*']) {
      expect(U.ACCEPT_ATTR.split(',')).toContain(x);
    }
    expect(U.PHOTO_ACCEPT_ATTR).not.toMatch(/zip|xlsx/);
  });
});
