const fs   = require('fs');
const path = require('path');

// The Lines cell on a report. It replaced a column that listed every line's
// category verbatim, which made a folio split four ways 170px tall; the
// replacement then read "4 lines · " with a separator pointing at nothing when
// the reader had landed no category, and was blank for a single such line.
//
// The function is pure and lives in a page component, so it is lifted out of
// the source rather than exported for a test that would be its only caller.
// Renaming it fails here loudly, which is the intent.
const SRC = path.join(__dirname, '../../ui/src/pages/ReportDetail.jsx');

function summariseFromSource() {
  const src = fs.readFileSync(SRC, 'utf8');
  const fn = src.match(/^function summarise[\s\S]*?^}/m);
  if (!fn) throw new Error('summarise() is no longer a top-level function in ReportDetail.jsx');
  return new Function(`${fn[0]}; return summarise;`)();
}

describe('the Lines cell on a report', () => {
  const summarise = summariseFromSource();
  const lines = (...cats) => cats.map(c => (c ? { category: c } : {}));

  test('names the categories, and says how many lines when there is more than one', () => {
    expect(summarise(lines('Meals'))).toBe('Meals');
    expect(summarise(lines('Lodging', 'Lodging', 'Meals', 'Meals'))).toBe('4 lines · Lodging, Meals');
  });

  test('counts the categories it did not have room to name', () => {
    expect(summarise(lines('Lodging', 'Meals', 'Air & Transport'))).toBe('3 lines · Lodging, Meals +1');
  });

  test('says something for lines the reader gave no category', () => {
    expect(summarise(lines(null))).toBe('Uncategorised');
    expect(summarise(lines(null, null, null, null))).toBe('4 lines · Uncategorised');
    expect(summarise(lines('Meals', null))).toBe('2 lines · Meals');
  });

  test('a receipt with no lines is a dash, not an empty cell', () => {
    expect(summarise([])).toBe('—');
    expect(summarise()).toBe('—');
  });

  // The dagger is explained by a footnote under the table naming the person.
  test('marks a line paid on behalf of somebody else', () => {
    expect(summarise([{ category: 'Lodging', onBehalfOf: 'Henry Bennett' }])).toBe('Lodging ‡');
    expect(summarise([{ onBehalfOf: 'Henry Bennett' }])).toBe('Uncategorised ‡');
    expect(summarise([{ category: 'Lodging' }, { category: 'Meals', onBehalfOf: 'H' }])).toBe('2 lines · Lodging, Meals ‡');
  });
});
