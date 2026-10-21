const fs   = require('fs');
const path = require('path');

// The dates a case and a receipt show on screen (ui/src/utils/format.js) and
// the names of the three kinds of case (ui/src/utils/kinds.js).
//
// Jest here runs CommonJS without a transform, and both files are ES modules,
// so each is loaded from its source with its `export` keywords taken off. That
// only works while they import nothing, which their own headers say; an import
// added to either fails here loudly rather than being quietly skipped.
const UI = path.join(__dirname, '../../ui/src/utils');

function loadModule(file, names) {
  const src = fs.readFileSync(path.join(UI, file), 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error(`${file} imports something now; this test can only load a module that does not`);
  const body = src.replace(/^export\s+(?=(function|const|let|class)\s)/gm, '');
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}

describe('fmtDateRange: a case\'s dates said once', () => {
  const { fmtDateRange } = loadModule('format.js', ['fmtDateRange']);

  test('within one month, the month and year are said once', () => {
    expect(fmtDateRange('2026-09-01', '2026-09-04')).toBe('1–4 Sep 2026');
  });

  test('across two months of one year, the year is said once', () => {
    expect(fmtDateRange('2026-09-28', '2026-10-02')).toBe('28 Sep – 2 Oct 2026');
  });

  test('across a new year, both years are said', () => {
    expect(fmtDateRange('2026-12-30', '2027-01-02')).toBe('30 Dec 2026 – 2 Jan 2027');
  });

  test('exactly one whole month is the month', () => {
    expect(fmtDateRange('2026-10-01', '2026-10-31')).toBe('Oct 2026');
    expect(fmtDateRange('2026-09-01', '2026-09-30')).toBe('Sep 2026');
    expect(fmtDateRange('2028-02-01', '2028-02-29')).toBe('Feb 2028');
    // One day short of the month is a range, not the month.
    expect(fmtDateRange('2026-10-01', '2026-10-30')).toBe('1–30 Oct 2026');
    expect(fmtDateRange('2026-02-01', '2026-02-28')).toBe('Feb 2026');
    expect(fmtDateRange('2028-02-01', '2028-02-28')).toBe('1–28 Feb 2028');
  });

  test('one day is that day', () => {
    expect(fmtDateRange('2026-09-03', '2026-09-03')).toBe('3 Sep 2026');
  });

  test('one end missing says which end there is', () => {
    expect(fmtDateRange('2026-09-03', null)).toBe('From 3 Sep 2026');
    expect(fmtDateRange('', '2026-09-04')).toBe('Until 4 Sep 2026');
    expect(fmtDateRange(null, undefined)).toBe('—');
    expect(fmtDateRange('', '')).toBe('—');
  });

  test('ends the wrong way round are put right', () => {
    expect(fmtDateRange('2026-09-04', '2026-09-01')).toBe('1–4 Sep 2026');
  });

  test('a date that is not on the calendar counts as missing', () => {
    expect(fmtDateRange('2026-02-30', '2026-03-02')).toBe('Until 2 Mar 2026');
    expect(fmtDateRange('soon', 'later')).toBe('—');
  });

  // The whole point of reading the digits: through new Date() the 1st became
  // the 31st anywhere west of Greenwich.
  test('never moves a date through a timezone', () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(fmtDateRange('2026-09-01', '2026-09-30')).toBe('Sep 2026');
      expect(fmtDateRange('2026-09-01T00:00:00Z', '2026-09-04')).toBe('1–4 Sep 2026');
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });
});

describe('fmtDay: one date, short', () => {
  const { fmtDay } = loadModule('format.js', ['fmtDay']);
  const today = '2026-10-21';

  test('this year leaves the year off; any other year keeps it', () => {
    expect(fmtDay('2026-09-02', { today })).toBe('2 Sep');
    expect(fmtDay('2025-12-30', { today })).toBe('30 Dec 2025');
    expect(fmtDay('2027-01-02', { today })).toBe('2 Jan 2027');
  });

  test('the year can be asked for', () => {
    expect(fmtDay('2026-09-02', { today, withYear: true })).toBe('2 Sep 2026');
  });

  test('a blank or unreadable date is a dash', () => {
    expect(fmtDay(null)).toBe('—');
    expect(fmtDay('')).toBe('—');
    expect(fmtDay('2026-13-01')).toBe('—');
  });

  test('without `today` it compares with the current year', () => {
    const year = new Date().getFullYear();
    expect(fmtDay(`${year}-03-04`)).toBe('4 Mar');
    expect(fmtDay(`${year - 1}-03-04`)).toBe(`4 Mar ${year - 1}`);
  });
});

describe('kinds: what the screen calls trip, period and case', () => {
  const { KINDS, KIND_LABEL, KIND_HINT, KIND_GLYPH, kindLabel } = loadModule('kinds.js', ['KINDS', 'KIND_LABEL', 'KIND_HINT', 'KIND_GLYPH', 'kindLabel']);

  // The database's CHECK constraint: a fourth kind on screen would be one the
  // server refuses.
  test('the three kinds the database allows, and no others', () => {
    expect(KINDS).toEqual(['trip', 'period', 'case']);
    expect(Object.keys(KIND_LABEL).sort()).toEqual([...KINDS].sort());
    expect(Object.keys(KIND_HINT).sort()).toEqual([...KINDS].sort());
    expect(Object.keys(KIND_GLYPH).sort()).toEqual([...KINDS].sort());
  });

  test('read Trip / Month / Other', () => {
    expect(KIND_LABEL).toEqual({ trip: 'Trip', period: 'Month', case: 'Other' });
    expect(kindLabel('period')).toBe('Month');
    expect(kindLabel(null)).toBe('Other');
    expect(kindLabel('mystery')).toBe('mystery');
  });

  test('every kind has a hint that says something', () => {
    for (const k of KINDS) expect(KIND_HINT[k].length).toBeGreaterThan(20);
  });
});
