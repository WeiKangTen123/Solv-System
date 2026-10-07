const ExcelJS = require('exceljs');
const { parseClaimForm, excelSerialToISO, cellDate, cellNumber, currencyOf, normaliseHeader, MAX_UNPACKED_BYTES } = require('./claim-form');

// Builds a spreadsheet shaped like the real BLACKSTAR claim form: a title block,
// a header row several rows down, filled lines, blank template lines, then a
// footer with totals and a declaration.
async function makeForm({ rows = [], includeFooter = true, headerRow = 7 } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Claim');
  ws.getCell('A1').value = 'BLACKSTAR';
  ws.getCell('A2').value = 'EXPENSES CLAIM FORM';
  ws.getCell('A5').value = 'Claim Period From: ';

  const h = ws.getRow(headerRow);
  h.getCell(1).value = 'No';
  h.getCell(2).value = 'DATE';
  h.getCell(3).value = 'DESCRIPTION OF EXPENSES';
  h.getCell(8).value = 'Currency';
  h.getCell(9).value = 'Amount';
  h.getCell(10).value = 'Exchange Rate';
  h.getCell(12).value = 'HOTEL ACCOMODATION \n(SGD)';
  h.getCell(13).value = 'LOCAL TRAVEL COST\n(SGD)';
  h.getCell(14).value = 'SGD AMOUNT';

  let r = headerRow + 2;
  for (const row of rows) {
    const x = ws.getRow(r++);
    x.getCell(1).value = row.no;
    x.getCell(2).value = row.date;
    x.getCell(3).value = row.description;
    x.getCell(8).value = row.currency || 'SGD';
    x.getCell(9).value = row.amount;
    x.getCell(10).value = row.fx ?? 1;
    if (row.travel) x.getCell(13).value = row.travel;
  }
  // Pre-formatted empty lines, exactly as the real form carries them.
  for (let i = 0; i < 5; i++) {
    const x = ws.getRow(r++);
    x.getCell(1).value = rows.length + i + 1;
    x.getCell(8).value = 'SGD';
    x.getCell(9).value = 0;
    x.getCell(10).value = 1;
  }
  if (includeFooter) {
    ws.getRow(r++).getCell(3).value = 'Total';
    ws.getRow(r++).getCell(1).value = 'All supporting receipts must be attached.';
    ws.getRow(r++).getCell(1).value = 'I declared the expense claimed above were actually incurred.';
    ws.getRow(r++).getCell(1).value = 'Claimant:';
    ws.getRow(r++).getCell(1).value = 'FOR FINANCE PURPOSE ONLY:';
    ws.getRow(r++).getCell(1).value = 'ACCOUNTS CODE';
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const SAMPLE = [
  { no: 1, date: new Date(Date.UTC(2026, 1, 23)), description: 'Grab to meeting with Solve', amount: 15.8 },
  { no: 2, date: new Date(Date.UTC(2026, 1, 26)), description: 'transport Apple to Spotify', amount: 56.7 },
  { no: 3, date: new Date(Date.UTC(2026, 3, 17)), description: 'transport to vinyl event', amount: 21.8, travel: 21.8 },
];

describe('claims/claim-form', () => {
  test('reads only the filled claim lines', async () => {
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE }));
    expect(r.rows).toHaveLength(3);
    expect(r.rows.map(x => x.amount)).toEqual([15.8, 56.7, 21.8]);
    expect(r.error).toBeNull();
  });

  test('blank template lines are not claims, even though they carry a number and a currency', async () => {
    // The real form had nine filled rows and dozens of formatted empties which
    // arrive as amount 0 rather than null. Reading those produced 56 phantom rows.
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE }));
    expect(r.rows.every(x => x.amount > 0 || x.description)).toBe(true);
  });

  test('stops at the footer instead of reading declarations as claim lines', async () => {
    // "I declared the expense claimed above..." was becoming a claim row.
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE }));
    const text = r.rows.map(x => x.description).join(' ');
    expect(text).not.toMatch(/declared|Total|Claimant|ACCOUNTS CODE/i);
  });

  test('finds the header wherever it sits, not at a fixed row', async () => {
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE, headerRow: 11 }));
    expect(r.rows).toHaveLength(3);
  });

  test('maps by header NAME, so an inserted column does not shift everything', async () => {
    // Hard-coding "date is column B" breaks the first time somebody adds a column.
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE }));
    expect(r.rows[0].description).toBe('Grab to meeting with Solve');
    expect(r.rows[0].date).toBe('2026-02-23');
  });

  test('collects the category columns and reads a ticked one', async () => {
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE }));
    expect(r.categories.some(c => /LOCAL TRAVEL/i.test(c))).toBe(true);
    expect(r.rows[2].category).toMatch(/LOCAL TRAVEL/i);
    // The gap the AI fills: most rows have no category at all.
    expect(r.rows[0].category).toBeNull();
  });

  test('a file that is not a spreadsheet degrades to no rows with a reason', async () => {
    const r = await parseClaimForm(Buffer.from('this is not xlsx'));
    expect(r.rows).toEqual([]);
    expect(r.error).toMatch(/not a readable spreadsheet/);
  });

  test('an empty buffer is handled', async () => {
    expect((await parseClaimForm(Buffer.alloc(0))).error).toBe('empty file');
    expect((await parseClaimForm(null)).error).toBe('empty file');
  });

  describe('cell coercion', () => {
    test('Excel date serials convert on the 1899-12-30 epoch', () => {
      // Excel's epoch is shifted by the 1900 leap-year bug it deliberately keeps.
      expect(excelSerialToISO(46076)).toBe('2026-02-23');
      expect(excelSerialToISO(0)).toBeNull();
      expect(excelSerialToISO('nonsense')).toBeNull();
    });

    test('dates arrive as Date objects, serials or strings', () => {
      expect(cellDate(new Date(Date.UTC(2026, 1, 23)))).toBe('2026-02-23');
      expect(cellDate(46076)).toBe('2026-02-23');
      expect(cellDate('2026-02-23')).toBe('2026-02-23');
      expect(cellDate('')).toBeNull();
    });

    test('amounts survive currency symbols and thousands separators', () => {
      expect(cellNumber(15.8)).toBe(15.8);
      expect(cellNumber('S$1,234.50')).toBe(1234.5);
      expect(cellNumber('')).toBeNull();
    });

    test('headers match despite wrapping, case and brackets', () => {
      expect(normaliseHeader('LOCAL TRAVEL COST\n(SGD)')).toBe('LOCAL TRAVEL COST SGD');
      expect(normaliseHeader('  Amount  ')).toBe('AMOUNT');
    });

    test('a date typed as text is read day first, and a date with a time keeps its day', () => {
      expect(cellDate('26/02/2026')).toBe('2026-02-26');
      expect(cellDate('26-2-26')).toBe('2026-02-26');
      expect(cellDate('31/02/2026')).toBeNull();
      // 6pm on the 26th. Rounding the serial made it the 27th.
      expect(excelSerialToISO(46079.75)).toBe('2026-02-26');
      expect(cellDate(46079.75)).toBe('2026-02-26');
    });

    test('a typed currency becomes its code, and a bare "$" names none', () => {
      expect(currencyOf('S$')).toBe('SGD');
      expect(currencyOf('RM')).toBe('MYR');
      expect(currencyOf('sgd')).toBe('SGD');
      expect(currencyOf('US$')).toBe('USD');
      expect(currencyOf('Amount (SGD)')).toBe('SGD');
      expect(currencyOf('$')).toBeNull();
      expect(currencyOf('')).toBeNull();
    });
  });

  test('the word "total" in a dated claim line does not end the form', async () => {
    const buf = await makeForm({ rows: [
      { no: 1, date: new Date('2026-09-01T00:00:00Z'), description: 'Grab to client', amount: 18.4 },
      { no: 2, date: new Date('2026-09-02T00:00:00Z'), description: 'Petrol at Total Energies station', amount: 60 },
      { no: 3, date: new Date('2026-09-03T00:00:00Z'), description: 'Parking', amount: 5 },
    ] });
    const out = await parseClaimForm(buf);
    expect(out.rows.map(r => r.description)).toEqual(['Grab to client', 'Petrol at Total Energies station', 'Parking']);
  });

  test('a footer word inside a line ends nothing, even on a line with no date or number', async () => {
    const out = await parseClaimForm(await workbook(ws => {
      put(ws, 3, ['No', 'Date', 'Description', 'Amount']);
      put(ws, 4, [undefined, '26 Feb', 'Petrol at Total Energies', 60]);
      put(ws, 5, [undefined, undefined, 'Parking', 5]);
      put(ws, 6, [undefined, undefined, 'Total', 65]);
      put(ws, 7, [undefined, undefined, 'Claimant: J. Tan', 1]);
    }));
    expect(out.rows.map(r => r.description)).toEqual(['Petrol at Total Energies', 'Parking']);
  });

  test('a header with nothing under it says so rather than reading as an empty claim', async () => {
    const out = await parseClaimForm(await makeForm({ rows: [] }));
    expect(out.rows).toEqual([]);
    expect(out.error).toMatch(/no claim lines/);
  });
});

// A workbook built cell by cell, for the layouts makeForm does not cover.
async function workbook(build) {
  const wb = new ExcelJS.Workbook();
  build(wb.addWorksheet('Claim'));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const put = (ws, r, cells) => cells.forEach((v, i) => { if (v !== undefined) ws.getRow(r).getCell(i + 1).value = v; });
const day = d => new Date(Date.UTC(2026, 1, d));

describe('claims/claim-form — headings as real forms write them', () => {
  test('"Amount (SGD)" is the claimed amount, in the currency it names', async () => {
    // It was taken for the converted figure, and every line had no amount.
    const out = await parseClaimForm(await workbook(ws => {
      put(ws, 3, ['No', 'Date', 'Description', 'Amount (SGD)']);
      put(ws, 4, [1, day(23), 'Grab', 15.8]);
    }));
    expect(out.rows[0]).toMatchObject({ amount: 15.8, currency: 'SGD' });
    expect(out.categories).toEqual([]);
  });

  test('"Amount (S$)" and "Amount Claimed" are amounts, not categories', async () => {
    for (const heading of ['Amount (S$)', 'Amount Claimed']) {
      const out = await parseClaimForm(await workbook(ws => {
        put(ws, 3, ['No', 'Date', 'Description', heading, 'MEALS']);
        put(ws, 4, [1, day(23), 'Lunch', 22.5]);
      }));
      expect(out.rows[0].amount).toBe(22.5);
      expect(out.categories).toEqual(['MEALS']);
    }
  });

  test('a form with only a converted amount is claimed in it', async () => {
    const out = await parseClaimForm(await workbook(ws => {
      put(ws, 3, ['No', 'Date', 'Description', 'Currency', 'SGD Amount']);
      put(ws, 4, [1, day(23), 'Hotel', 'USD', 270]);
    }));
    expect(out.rows[0]).toMatchObject({ amount: 270, currency: 'SGD' });
  });

  test('a currency typed as a symbol is stored as its code', async () => {
    const out = await parseClaimForm(await makeForm({ rows: [{ ...SAMPLE[0], currency: 'S$' }, { ...SAMPLE[1], currency: 'RM' }] }));
    expect(out.rows.map(r => r.currency)).toEqual(['SGD', 'MYR']);
  });

  test('a receipt number and a GST column are not categories, and tick nothing', async () => {
    // A numeric receipt number "ticked" every line, so none was left for the
    // model to categorise.
    const out = await parseClaimForm(await workbook(ws => {
      put(ws, 3, ['No', 'Date', 'Description', 'Amount', 'Receipt No', 'GST', 'TRANSPORT', 'MEALS']);
      put(ws, 4, [1, day(23), 'Grab', 15.8, 102345, 1.3]);
      put(ws, 5, [2, day(24), 'Lunch', 20, 102346, 1.65, undefined, 20]);
    }));
    expect(out.categories).toEqual(['TRANSPORT', 'MEALS']);
    expect(out.rows[0].category).toBeNull();
    expect(out.rows[1].category).toBe('MEALS');
  });

  test('a two-row header with merged cells: the second row is header, and it names the categories', async () => {
    const out = await parseClaimForm(await workbook(ws => {
      put(ws, 6, ['No', 'Date', 'Description', 'Currency', 'Amount', 'CATEGORY']);
      ws.mergeCells('F6:I6');
      for (const c of ['A', 'B', 'C', 'D', 'E']) ws.mergeCells(`${c}6:${c}7`);
      // "TOTAL" under the group used to end the form before its first line.
      put(ws, 7, [undefined, undefined, undefined, undefined, undefined, 'HOTEL', 'LOCAL TRAVEL', 'MEALS', 'TOTAL']);
      put(ws, 8, [1, day(23), 'Grab to client', 'SGD', 15.8, undefined, 15.8, undefined, 15.8]);
      put(ws, 9, [2, day(24), 'Lunch', 'SGD', 20, undefined, undefined, undefined, 20]);
    }));
    expect(out.error).toBeNull();
    expect(out.rows.map(r => r.description)).toEqual(['Grab to client', 'Lunch']);
    expect(out.categories).toEqual(['HOTEL', 'LOCAL TRAVEL', 'MEALS']);
    expect(out.rows[0].category).toBe('LOCAL TRAVEL');
    expect(out.rows[1].category).toBeNull();
  });
});

// ── A spreadsheet that unpacks to far more than it says ─────────────────────
describe('claims/claim-form — the unpacked size is counted, not taken on trust', () => {
  const zlib = require('zlib');

  // A zip of one deflated entry of `megabytes` of zeros, whose directory
  // declares `declared` bytes. One compressed megabyte repeated is a valid
  // deflate stream, so the test never holds the whole of it.
  function bomb(megabytes, declared) {
    const block = zlib.deflateRawSync(Buffer.alloc(1024 * 1024), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    const body = Buffer.concat([...Array(megabytes).fill(block), zlib.deflateRawSync(Buffer.alloc(0))]);
    const name = Buffer.from('xl/worksheets/sheet1.xml');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(declared, 22); local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(declared, 24); cen.writeUInt16LE(name.length, 28);
    const cd = Buffer.concat([cen, name]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(local.length + name.length + body.length, 16);
    return Buffer.concat([local, name, body, cd, end]);
  }

  // Counts what the inflater really produces. zlib's exports are read-only,
  // so the factory is swapped with defineProperty and put back afterwards.
  let inflated = 0;
  const original = Object.getOwnPropertyDescriptor(zlib, 'createInflateRaw');
  beforeEach(() => {
    inflated = 0;
    Object.defineProperty(zlib, 'createInflateRaw', { ...original, value: (...args) => {
      const stream = original.value.apply(zlib, args);
      const push = stream.push.bind(stream);
      stream.push = (chunk, encoding) => { if (chunk) inflated += chunk.length; return push(chunk, encoding); };
      return stream;
    } });
  });
  afterEach(() => Object.defineProperty(zlib, 'createInflateRaw', original));

  test('an entry whose directory under-states its size is refused without being inflated', async () => {
    const out = await parseClaimForm(bomb(200, 100));
    expect(out.error).toBe('not a readable spreadsheet');
    expect(inflated).toBeGreaterThan(0);
    expect(inflated).toBeLessThan(1024 * 1024);          // of 200 MB
  });

  test('one that states its size honestly is stopped at the limit', async () => {
    const out = await parseClaimForm(bomb(200, 200 * 1024 * 1024));
    expect(out.error).toMatch(/unpacks to far more/);
    expect(inflated).toBeLessThan(2 * MAX_UNPACKED_BYTES);
  });
});
