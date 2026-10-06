// The small shared helpers that replaced copies in several files.
const { formatAmount } = require('./money');
const { maskKey } = require('./mask');
const { receiptRefs } = require('../reports/expense-payload');
const { SOURCE_NAME, SOURCE_LONG, SOURCE_VIA } = require('../fx/sources');

describe('shared helpers', () => {
  test('formatAmount: two decimals, separators, and the empty value each caller wants', () => {
    expect(formatAmount(1234.5)).toBe('1,234.50');
    expect(formatAmount(null)).toBe('0.00');
    expect(formatAmount(null, { empty: '' })).toBe('');
    expect(formatAmount('', { empty: 'empty' })).toBe('empty');
  });

  test('maskKey shows only the ends', () => {
    expect(maskKey('AIzaSy-1234567890')).toBe('AIza••••••••7890');
    expect(maskKey('short')).toBe('••••');
  });

  test('receiptRefs numbers each file once, in order', () => {
    const refs = receiptRefs([{ receipt: { id: 'a' } }, { receipt: null }, { receipt: { id: 'b' } }, { receipt: { id: 'a' } }]);
    expect([...refs.entries()]).toEqual([['a', 'R1'], ['b', 'R2']]);
  });

  test('every rate source has a name, a long name and where it came from', () => {
    for (const k of ['openexchangerates', 'frankfurter', 'open.er-api', 'manual']) {
      expect([SOURCE_NAME[k], SOURCE_LONG[k], SOURCE_VIA[k]].every(Boolean)).toBe(true);
    }
  });
});
