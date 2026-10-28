const fs = require('fs');
const path = require('path');
const { DECLARATION, declarationFor, currentClaim, DECLARED_NOTE } = require('./declaration');

describe('reports/declaration', () => {
  // The claim window shows the UI's copy; the PDF prints this one and says the
  // claimant declared it. If they drifted, the PDF would put words in their
  // mouth that the window never showed.
  test('the claim window shows the same words the PDF prints', () => {
    const ui = fs.readFileSync(path.join(__dirname, '../../ui/src/utils/declaration.js'), 'utf8');
    const m = /export const DECLARATION = '((?:[^'\\]|\\.)*)';/.exec(ui);
    expect(m).not.toBeNull();
    expect(m[1].replace(/\\'/g, "'")).toBe(DECLARATION);
  });

  test('the company is named, or "the company" when it has no name', () => {
    expect(declarationFor('Solv Pte Ltd')).toContain('for the business of Solv Pte Ltd,');
    expect(declarationFor('  ')).toContain('for the business of the company,');
  });

  test('the claim that counts is the last one, unless a reopening came after it', () => {
    const claimed = { action: 'claimed', note: DECLARED_NOTE };
    expect(currentClaim([{ action: 'created' }, claimed])).toBe(claimed);
    expect(currentClaim([claimed, { action: 'reopened' }])).toBeNull();
    const again = { action: 'claimed', note: null };
    expect(currentClaim([claimed, { action: 'reopened' }, again, { action: 'posted' }])).toBe(again);
    expect(currentClaim()).toBeNull();
  });
});
