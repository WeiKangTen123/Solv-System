const zlib = require('zlib');
const ExcelJS = require('exceljs');
const claimImport = require('./claim-import');

// Everything slow or stateful is injected, so the whole job runs in
// milliseconds with no model, no database and no disk.
function makeZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = zlib.crc32 ? zlib.crc32(body) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(body.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

async function makeForm(rows) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('C');
  ws.getCell('A1').value = 'BLACKSTAR';
  const h = ws.getRow(7);
  h.getCell(1).value = 'No'; h.getCell(2).value = 'DATE'; h.getCell(3).value = 'DESCRIPTION OF EXPENSES';
  h.getCell(8).value = 'Currency'; h.getCell(9).value = 'Amount'; h.getCell(10).value = 'Exchange Rate';
  h.getCell(13).value = 'LOCAL TRAVEL COST\n(SGD)';
  rows.forEach((r, i) => {
    const x = ws.getRow(9 + i);
    x.getCell(1).value = r.no; x.getCell(2).value = new Date(r.date + 'T00:00:00Z');
    x.getCell(3).value = r.description; x.getCell(8).value = 'SGD'; x.getCell(9).value = r.amount;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const settle = async job => { for (let i = 0; i < 200 && !['done','failed','cancelled'].includes(job.stage); i++) await new Promise(r => setTimeout(r, 5)); return job; };
// Hands out these reads in order, however many receipts the job asks for at a time.
const inOrder = list => { let next = 0; return jest.fn(async (userId, images) => images.map(() => (next < list.length ? list[next++] : null))); };

function deps({ reads = {}, onCreate } = {}) {
  return {
    // waitMs 0: the four-second throttle is for the real model's quota, not tests.
    waitMs: 0,
    // The job now reads in batches: one call for several images, returning an
    // array the same length as the input.
    parseReceipts: jest.fn(async (userId, images) => images.map(() => null)),
    storeReceipt: jest.fn(async () => 'stored.jpg'),
    createRecord: jest.fn(async ({ row }) => { onCreate && onCreate(row); return { id: 'rec-' + row.no }; }),
    suggest: jest.fn(async () => []),
  };
}

describe('claims/claim-import', () => {
  beforeEach(() => claimImport._reset());

  test('runs every stage and reports a reconciliation', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }, { name: 'c/b.png', data: JPEG }]);
    const form = await makeForm([
      { no: 1, date: '2026-02-23', description: 'Grab to meeting', amount: 15.8 },
      { no: 2, date: '2026-02-26', description: 'Taxi home', amount: 56.7 },
    ]);
    const seen = [];
    const d = {
      ...deps({ onCreate: r => seen.push(r.no) }),
      parseReceipts: inOrder([
        { merchant: 'Grab', date: '2026-02-23', total: 15.8, currency: 'SGD' },
        { merchant: 'CDG',  date: '2026-02-26', total: 56.7, currency: 'SGD' },
      ]),
    };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [{ name: 'f.xlsx', buffer: form }] }, d);
    await settle(job);

    expect(job.stage).toBe('done');
    expect(job.result.summary).toMatchObject({ total: 2, matched: 2, verified: 2, discrepancies: 0 });
    expect(seen.sort()).toEqual(['1', '2']);
  });

  test('an amount mismatch reaches the reconciliation, with the numbers', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }]);
    const form = await makeForm([{ no: 1, date: '2026-02-26', description: 'Home to Apple', amount: 30.6 }]);
    const d = { ...deps(), parseReceipts: jest.fn(async () => ([{ merchant: 'CDG', date: '2026-02-26', total: 36.0 }])) };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [{ name: 'f.xlsx', buffer: form }] }, d);
    await settle(job);

    expect(job.result.summary.discrepancies).toBe(1);
    expect(job.result.discrepancies[0]).toMatchObject({ rowNo: '1', claimed: 30.6, onReceipt: 36, difference: 5.4 });
  });

  test('a claim line with no receipt still becomes a record for somebody to resolve', async () => {
    const form = await makeForm([{ no: 1, date: '2026-02-23', description: 'Taxi to airport', amount: 500 }]);
    const seen = [];
    const job = claimImport.startImport(
      { userId: 'u1', archives: [], forms: [{ name: 'f.xlsx', buffer: form }] },
      deps({ onCreate: r => seen.push(r.no) }));
    await settle(job);

    expect(job.result.summary.missingReceipts).toBe(1);
    expect(job.result.missingReceipts[0].description).toBe('Taxi to airport');
    expect(seen).toEqual(['1']);   // created, not dropped
  });

  test('one unreadable receipt does not stop the rest', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }, { name: 'c/b.png', data: JPEG }]);
    const form = await makeForm([{ no: 1, date: '2026-02-23', description: 'Grab', amount: 15.8 }]);
    const d = { ...deps(),
      // one unreadable, one fine — the batch reader returns null in place.
      parseReceipts: inOrder([null, { merchant: 'Grab', date: '2026-02-23', total: 15.8 }]) };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [{ name: 'f.xlsx', buffer: form }] }, d);
    await settle(job);

    expect(job.stage).toBe('done');
    expect(job.result.summary.unreadable).toBe(1);
    expect(job.result.summary.verified).toBe(1);
  });

  test('progress counts up as receipts are read', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }, { name: 'c/b.png', data: JPEG }, { name: 'c/c.png', data: JPEG }]);
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, deps());
    await settle(job);
    expect(job.receiptsTotal).toBe(3);
    expect(job.receiptsRead).toBe(3);
  });

  test('a job belongs to the user who started it', async () => {
    const job = claimImport.startImport({ userId: 'u1', archives: [], forms: [] }, deps());
    await settle(job);
    expect(claimImport.getJob(job.id, 'u1')).toBeTruthy();
    expect(claimImport.getJob(job.id, 'u2')).toBeNull();
    expect(claimImport.listJobs('u2')).toEqual([]);
  });

  test('an absurdly large archive is refused rather than run up a bill', async () => {
    const many = Array.from({ length: claimImport.MAX_RECEIPTS + 1 }, (_, i) => ({ name: `c/${i}.png`, data: JPEG }));
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: makeZip(many) }], forms: [] }, deps());
    await settle(job);
    expect(job.stage).toBe('failed');
    expect(job.error).toMatch(/more than one claim should hold/);
  });

  test('a corrupt spreadsheet is reported without stopping the receipts', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }]);
    const d = { ...deps(), parseReceipts: jest.fn(async () => ([{ merchant: 'Grab', date: '2026-02-23', total: 15.8 }])) };
    const job = claimImport.startImport(
      { userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [{ name: 'bad.xlsx', buffer: Buffer.from('nope') }] }, d);
    await settle(job);
    expect(job.stage).toBe('done');
    expect(job.result.formErrors[0]).toMatch(/not a readable spreadsheet/);
    expect(job.result.summary.extraReceipts).toBe(1);   // a receipt with no claim line
  });

  test('a job can be cancelled mid-read', async () => {
    const zip = makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `c/${i}.png`, data: JPEG })));
    const d = { ...deps(), waitMs: 20, batch: 1, parseReceipts: jest.fn(async (u, imgs) => imgs.map(() => ({ merchant: 'x', date: '2026-01-01', total: 1 }))) };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await new Promise(r => setTimeout(r, 30));
    claimImport.cancel(job.id, 'u1');
    await settle(job);
    expect(job.stage).toBe('cancelled');
    expect(job.receiptsRead).toBeLessThan(6);
  });
});

// ── A claim with no spreadsheet ─────────────────────────────────────────────
// The commonest case, and the one that produced nothing: a zip of receipts with
// no form matched nothing, so no records were created and the import reported
// success having imported zero claims.
describe('claims/claim-import — receipts without a claim form', () => {
  beforeEach(() => claimImport._reset());

  test('a zip of receipts and no form still becomes one claim each', async () => {
    const zip = makeZip([
      { name: 'c/a.png', data: JPEG }, { name: 'c/b.png', data: JPEG }, { name: 'c/c.png', data: JPEG },
    ]);
    const seen = [];
    const d = {
      waitMs: 0,
      storeReceipt: jest.fn(async () => 'stored.jpg'),
      createRecord: jest.fn(async ({ row, receipt }) => { seen.push({ amount: row.amount, merchant: receipt && receipt.merchant }); return { id: 'r' + seen.length }; }),
      suggest: jest.fn(async () => []),
      parseReceipts: inOrder([
        { merchant: 'Grab',  date: '2026-02-23', total: 15.8, currency: 'SGD' },
        { merchant: 'Gojek', date: '2026-03-10', total: 25,   currency: 'SGD' },
        { merchant: 'CDG',   date: '2026-04-17', total: 21.8, currency: 'SGD' },
      ]),
    };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await settle(job);

    expect(job.stage).toBe('done');
    expect(seen).toHaveLength(3);                                   // not zero
    expect(seen.map(s => s.amount).sort((a, b) => a - b)).toEqual([15.8, 21.8, 25]);
    expect(seen.map(s => s.merchant).sort()).toEqual(['CDG', 'Gojek', 'Grab']);
  });

  test('the figures come from what the model read, not left blank', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }]);
    let captured = null;
    const d = {
      waitMs: 0,
      storeReceipt: jest.fn(async () => 'stored.jpg'),
      createRecord: jest.fn(async (args) => { captured = args; return { id: 'r1' }; }),
      suggest: jest.fn(async () => []),
      parseReceipts: jest.fn(async () => ([{ merchant: 'Isetan', date: '2015-05-01', total: 6.6, currency: 'SGD' }])),
    };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await settle(job);

    expect(captured.row).toMatchObject({ date: '2015-05-01', amount: 6.6, currency: 'SGD', description: 'Isetan' });
    expect(captured.receipt.buffer).toBeInstanceOf(Buffer);   // the image is stored with it
  });

  test('an unreadable receipt with no form still becomes a claim to type by hand', async () => {
    const zip = makeZip([{ name: 'c/blurry.png', data: JPEG }]);
    let captured = null;
    const d = {
      waitMs: 0,
      storeReceipt: jest.fn(async () => 'stored.jpg'),
      createRecord: jest.fn(async (args) => { captured = args; return { id: 'r1' }; }),
      suggest: jest.fn(async () => []),
      parseReceipts: jest.fn(async (u, imgs) => imgs.map(() => null)),
    };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await settle(job);

    expect(captured).not.toBeNull();
    // Falls back to the filename so the row is identifiable in the list.
    expect(captured.row.description).toBe('blurry.png');
  });
});

// ── Batching ────────────────────────────────────────────────────────────────
// Nine receipts one at a time is nine round trips, each throttled for the
// per-minute quota. Batching is what makes a large claim finish in a minute.
describe('claims/claim-import — reads in batches', () => {
  beforeEach(() => claimImport._reset());

  test('nine receipts take three calls, not nine', async () => {
    const zip = makeZip(Array.from({ length: 9 }, (_, i) => ({ name: `c/${i}.png`, data: JPEG })));
    const parseReceipts = jest.fn(async (u, imgs) => imgs.map((_, i) => ({ merchant: 'M' + i, date: '2026-02-23', total: i + 1 })));
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] },
      { waitMs: 0, batch: 4, parseReceipts, storeReceipt: async () => 'f.jpg', createRecord: async () => ({ id: 'r' }), suggest: async () => [] });
    await settle(job);

    expect(parseReceipts).toHaveBeenCalledTimes(3);      // 4 + 4 + 1
    expect(parseReceipts.mock.calls[0][1]).toHaveLength(4);
    expect(parseReceipts.mock.calls[2][1]).toHaveLength(1);
    expect(job.receiptsRead).toBe(9);
  });

  test('a whole batch failing loses none of its receipts', async () => {
    const zip = makeZip(Array.from({ length: 4 }, (_, i) => ({ name: `c/${i}.png`, data: JPEG })));
    const created = [];
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] },
      { waitMs: 0, batch: 4,
        parseReceipts: jest.fn(async () => { throw new Error('quota'); }),
        storeReceipt: async () => 'f.jpg',
        createRecord: async ({ row }) => { created.push(row.description); return { id: 'r' + created.length }; },
        suggest: async () => [] });
    await settle(job);

    expect(job.stage).toBe('done');
    expect(job.result.summary.unreadable).toBe(4);
    expect(created).toHaveLength(4);                     // still four claims to type by hand
  });

  test('progress advances by batch, and lands exactly on the total', async () => {
    const zip = makeZip(Array.from({ length: 7 }, (_, i) => ({ name: `c/${i}.png`, data: JPEG })));
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] },
      { waitMs: 0, batch: 3,
        parseReceipts: jest.fn(async (u, imgs) => imgs.map(() => ({ merchant: 'x', date: '2026-01-01', total: 1 }))),
        storeReceipt: async () => 'f.jpg', createRecord: async () => ({ id: 'r' }), suggest: async () => [] });
    await settle(job);
    // 3 + 3 + 1: the last partial batch must not report 9 of 7.
    expect(job.receiptsRead).toBe(7);
    expect(job.receiptsTotal).toBe(7);
  });
});

describe('pacing', () => {
  test('reads are not paced here — gemini-client paces every caller at 15 a minute', () => {
    // Two throttles on one call chain hide each other; the client's sliding
    // window is the one that knows the quota, so the import adds none.
    expect(claimImport.READ_INTERVAL_MS).toBe(0);
  });
});

// A zip is a bundle of receipts that belong to each other. These run against a
// real database, and require claim-import inside beforeEach so the stores it
// holds are this test's instances rather than a stale module's.
describe('claims/claim-import — everything that arrives together becomes a case', () => {
  let ci, users, store, reports, u;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users   = require('../store/users');
    store   = require('../store/expenses');
    reports = require('../store/reports');
    ci = require('./claim-import');
    ci._reset();
    u = await users.createUser({ email: 'e@solv.sg', password: 'password123' });
  });

  const zipOfThree = () => makeZip([
    { name: 'c/a.png', data: JPEG }, { name: 'c/b.png', data: JPEG }, { name: 'c/c.png', data: JPEG },
  ]);
  const reads = [
    { merchant: 'Grab',  date: '2026-02-23', total: 15.8, currency: 'SGD' },
    { merchant: 'Gojek', date: '2026-03-10', total: 25,   currency: 'SGD' },
    { merchant: 'CDG',   date: '2026-04-17', total: 21.8, currency: 'SGD' },
  ];
  const realRecords = (mark = () => ({})) => jest.fn(async ({ row }) => {
    const e = store.createExpense({
      companyId: u.companyId, userId: u.id, status: 'review-needed',
      merchant: row.description, currency: row.currency || 'SGD', total: row.amount,
      lines: [{ category: 'Other', amount: row.amount, currency: row.currency || 'SGD' }],
    });
    return { ...e, ...mark(row) };
  });

  test('a zip of three receipts lands in one case, named after the file', async () => {
    const d = { waitMs: 0, storeReceipt: jest.fn(async () => 'stored.jpg'), suggest: jest.fn(async () => []),
                createRecord: realRecords(), parseReceipts: inOrder(reads) };
    const job = ci.startImport({ userId: u.id, archives: [{ name: 'September receipts.zip', buffer: zipOfThree() }], forms: [], label: 'September receipts.zip' }, d);
    await settle(job);

    expect(job.stage).toBe('done');
    expect(job.result.caseId).toBeTruthy();
    const c = reports.getReport(job.result.caseId);
    expect(c.kind).toBe('case');
    expect(c.title).toBe('September receipts');      // the extension is not part of the name
    expect(c.status).toBe('open');
    expect(c.number).toMatch(/^EXP-\d{4}-\d{4}$/);
    expect(c.expenses).toHaveLength(3);
    expect(c.expenses.map(e => e.merchant).sort()).toEqual(['CDG', 'Gojek', 'Grab']);
    expect(c.totals.unreviewed).toBe(3);             // read, and waiting for a person
  });

  test('a duplicate stays out of the case, because it could never be marked reviewed', async () => {
    const d = { waitMs: 0, storeReceipt: jest.fn(async () => 'stored.jpg'), suggest: jest.fn(async () => []),
                createRecord: realRecords(row => (row.description === 'Gojek' ? { status: 'duplicate' } : {})),
                parseReceipts: inOrder(reads) };
    const job = ci.startImport({ userId: u.id, archives: [{ name: 'c.zip', buffer: zipOfThree() }], forms: [], label: 'c.zip' }, d);
    await settle(job);

    const c = reports.getReport(job.result.caseId);
    expect(c.expenses).toHaveLength(2);
    expect(c.expenses.map(e => e.merchant).sort()).toEqual(['CDG', 'Grab']);
  });

  test('an import that creates nothing creates no case', async () => {
    const d = { waitMs: 0, storeReceipt: jest.fn(async () => 'stored.jpg'), suggest: jest.fn(async () => []),
                createRecord: jest.fn(async () => null), parseReceipts: jest.fn(async () => reads) };
    const job = ci.startImport({ userId: u.id, archives: [{ name: 'c.zip', buffer: zipOfThree() }], forms: [], label: 'c.zip' }, d);
    await settle(job);
    expect(job.result.caseId).toBeNull();
  });

  test('a PDF of several receipts in the archive becomes a record per receipt, sharing the one file', async () => {
    const zip = makeZip([{ name: 'c/receipts.pdf', data: Buffer.from('%PDF-1.4 four receipts') }]);
    const d = deps();
    d.parseReceipts = jest.fn(async (u, images) => images.map(() => ({ parts: [
      { r: { merchant: 'A', date: '2026-09-01', total: 10, currency: 'SGD' }, page: 1, box: null },
      { r: { merchant: 'B', date: '2026-09-02', total: 20, currency: 'SGD' }, page: 2, box: null },
      { r: null, page: 3, box: null },
    ] })));
    const seen = [];
    d.createRecord = jest.fn(async ({ receipt, files }) => { seen.push({ ...receipt, files: !!files }); return { id: `rec-${seen.length}` }; });
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await settle(job);
    expect(job.stage).toBe('done');
    expect(seen.map(r => [r.merchant, r.page, r.part, r.readable])).toEqual([['A', 1, 0, true], ['B', 2, 1, true], [null, 3, 2, false]]);
    expect(new Set(seen.map(r => r.fileKey)).size).toBe(1);
    expect(seen.every(r => r.files)).toBe(true);
  });

  test('an interrupted import clears what its last attempt saved before saving again', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }]);
    const d = deps();
    const order = [];
    d.clearPartial = jest.fn(() => { order.push('clear'); return { removed: 2 }; });
    d.createRecord = jest.fn(async () => { order.push('create'); return { id: 'r1' }; });
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [], id: 'job-7' }, d);
    await settle(job);
    expect(d.clearPartial).toHaveBeenCalledWith('u1', 'job-7');
    expect(order).toEqual(['clear', 'create']);
  });

  test('a cancel that arrives while receipts are read is honoured before anything is saved', async () => {
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }]);
    const d = deps();
    let release;
    d.parseReceipts = jest.fn(() => new Promise(r => { release = () => r([null]); }));
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 5));
    claimImport.cancel(job.id, 'u1');
    release();
    await settle(job);
    expect(job.stage).toBe('cancelled');
    expect(d.createRecord).not.toHaveBeenCalled();
  });
});

// ── A stop or a failure keeps nothing ───────────────────────────────────────
describe('claims/claim-import — a stop or a failure part-way keeps nothing', () => {
  beforeEach(() => claimImport._reset());
  const zipOf = n => makeZip(Array.from({ length: n }, (_, i) => ({ name: `c/${i}.png`, data: JPEG })));
  const readsOf = n => inOrder(Array.from({ length: n }, (_, i) => ({ merchant: `M${i}`, date: '2026-01-01', total: i + 1 })));

  test('a cancel during saving stops there and takes back what was saved', async () => {
    // Stop was only looked at before saving began: a cancel during it saved
    // the whole claim, and the panel said nothing had been kept.
    const d = { ...deps(), parseReceipts: readsOf(4), clearPartial: jest.fn(() => ({ removed: 2 })) };
    d.createRecord = jest.fn(async () => {
      if (d.createRecord.mock.calls.length === 2) claimImport.cancel('job-c', 'u1');
      return { id: `r${d.createRecord.mock.calls.length}` };
    });
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zipOf(4) }], forms: [], id: 'job-c' }, d);
    await settle(job);
    expect(job.stage).toBe('cancelled');
    expect(d.createRecord).toHaveBeenCalledTimes(2);
    // Once before saving (what a run before a restart left), once after the cancel.
    expect(d.clearPartial).toHaveBeenCalledTimes(2);
    expect(d.clearPartial).toHaveBeenLastCalledWith('u1', 'job-c');
    expect(job.result).toBeNull();
  });

  test('a failure part-way through saving takes back what was saved, and says so', async () => {
    const d = { ...deps(), parseReceipts: readsOf(3), clearPartial: jest.fn(() => ({ removed: 1 })) };
    d.createRecord = jest.fn(async () => {
      if (d.createRecord.mock.calls.length === 2) throw new Error('database is locked');
      return { id: 'r1' };
    });
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zipOf(3) }], forms: [], id: 'job-f' }, d);
    await settle(job);
    expect(job.stage).toBe('failed');
    expect(job.error).toMatch(/nothing from this import was kept: database is locked/);
    expect(d.clearPartial).toHaveBeenCalledTimes(2);
    expect(d.clearPartial).toHaveBeenLastCalledWith('u1', 'job-f');
  });

  test('cancelling an import that has already ended leaves it as it ended', async () => {
    // A failed import came back as 'cancelling', and the panel polled it for ever.
    const d = { ...deps(), createRecord: jest.fn(async () => { throw new Error('boom'); }) };
    const failed = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zipOf(1) }], forms: [] }, d);
    await settle(failed);
    expect(claimImport.cancel(failed.id, 'u1').stage).toBe('failed');
    expect(failed.stage).toBe('failed');
  });

  test('an import cancelled before a restart only takes back what it saved when it runs again', async () => {
    const d = { ...deps(), clearPartial: jest.fn(() => ({ removed: 3 })) };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zipOf(2) }], forms: [], id: 'job-r', cancelled: true }, d);
    await settle(job);
    expect(job.stage).toBe('cancelled');
    expect(d.parseReceipts).not.toHaveBeenCalled();
    expect(d.clearPartial).toHaveBeenCalledWith('u1', 'job-r');
  });
});

// ── Several archives and several forms in one import ────────────────────────
describe('claims/claim-import — several archives and forms in one import', () => {
  beforeEach(() => claimImport._reset());

  test('the receipt limit is for the whole import, not for each archive', async () => {
    const sixty = makeZip(Array.from({ length: 60 }, (_, i) => ({ name: `c/${i}.png`, data: JPEG })));
    const d = deps();
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'a.zip', buffer: sixty }, { name: 'b.zip', buffer: sixty }], forms: [] }, d);
    await settle(job);
    expect(job.stage).toBe('failed');
    expect(job.error).toMatch(/more than one claim should hold/);
    expect(d.parseReceipts).not.toHaveBeenCalled();
  });

  test('two archives with the same name do not share one stored file', async () => {
    const zip = makeZip([{ name: 'a.jpg', data: JPEG }]);
    const d = deps();
    d.parseReceipts = jest.fn(async (u, images) => images.map(() => ({ parts: [{ r: { merchant: 'X', date: '2026-01-01', total: 1 }, page: null, box: null }], notes: [] })));
    const keys = [];
    d.createRecord = jest.fn(async ({ receipt }) => { keys.push(receipt.fileKey); return { id: `r${keys.length}` }; });
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'receipts.zip', buffer: zip }, { name: 'receipts.zip', buffer: zip }], forms: [] }, d);
    await settle(job);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  test("what the reader says about a whole file goes on its first part's record", async () => {
    const zip = makeZip([{ name: 'long.pdf', data: Buffer.from('%PDF-1.4 long') }]);
    const d = deps();
    const note = 'Only the first 20 of 35 pages were read; check the rest by hand.';
    d.parseReceipts = jest.fn(async (u, images) => images.map(() => ({
      parts: [{ r: { merchant: 'A', date: '2026-09-01', total: 10 }, page: 1, box: null }, { r: { merchant: 'B', date: '2026-09-02', total: 20 }, page: 2, box: null }],
      notes: [note],
    })));
    const seen = [];
    d.createRecord = jest.fn(async ({ receipt }) => { seen.push([receipt.part, receipt.notes]); return { id: `r${seen.length}` }; });
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }], forms: [] }, d);
    await settle(job);
    expect(seen.sort()).toEqual([[0, note], [1, null]]);
  });

  test("two forms both numbered from 1 do not take each other's suggested category", async () => {
    // Both had a row "1", so the answer for one landed on both: "Taxi to
    // airport" came out as Meals.
    const formA = await makeForm([{ no: 1, date: '2026-02-23', description: 'Lunch with client', amount: 30 }]);
    const formB = await makeForm([{ no: 1, date: '2026-02-24', description: 'Taxi to airport', amount: 25 }]);
    const zip = makeZip([{ name: 'c/a.png', data: JPEG }, { name: 'c/b.png', data: JPEG }]);
    const { suggestCategories } = require('./claim-categories');
    // The model answers for the first line it was asked about, and no other.
    const callGemini = jest.fn(async () => JSON.stringify([{ rowNo: '1', category: 'LOCAL TRAVEL COST (SGD)', confidence: 'high' }]));
    const categoryOf = {};
    const d = { ...deps(),
      parseReceipts: inOrder([{ merchant: 'Cafe', date: '2026-02-23', total: 30 }, { merchant: 'Grab', date: '2026-02-24', total: 25 }]),
      suggest: (uid, matches, categories) => suggestCategories(uid, matches, categories, { callGemini }),
      createRecord: jest.fn(async ({ row, category }) => { categoryOf[row.description] = category; return { id: row.description }; }),
    };
    const job = claimImport.startImport({ userId: 'u1', archives: [{ name: 'c.zip', buffer: zip }],
      forms: [{ name: 'a.xlsx', buffer: formA }, { name: 'b.xlsx', buffer: formB }] }, d);
    await settle(job);
    expect(job.stage).toBe('done');
    expect(Object.keys(categoryOf).sort()).toEqual(['Lunch with client', 'Taxi to airport']);
    expect(Object.values(categoryOf).filter(Boolean)).toEqual(['LOCAL TRAVEL COST (SGD)']);
    expect(job.result.categoriesSuggested).toBe(1);
  });
});
