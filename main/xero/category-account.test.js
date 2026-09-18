const { accountForCategory, CATEGORY_HINTS } = require('./category-account');
const { CATEGORY_NAMES } = require('../intake/categories');

describe('xero/category-account', () => {
  const chart = [
    { code: '400', name: 'Advertising', type: 'EXPENSE', status: 'ACTIVE' },
    { code: '404', name: 'Bank Fees', type: 'EXPENSE', status: 'ACTIVE' },
    { code: '420', name: 'Entertainment', type: 'EXPENSE', status: 'ACTIVE' },
    { code: '429', name: 'General Expenses', type: 'EXPENSE', status: 'ACTIVE' },
    { code: '445', name: 'Light, Power, Heating', type: 'EXPENSE', status: 'ACTIVE' },
    { code: '449', name: 'Motor Vehicle Expenses', type: 'EXPENSE', status: 'ACTIVE' },
    { code: '461', name: 'Printing & Stationery', type: 'EXPENSE', status: 'ACTIVE' },
    { code: '485', name: 'Subscriptions', type: 'EXPENSE', status: 'ACTIVE' },
    { code: '489', name: 'Telephone & Internet', type: 'EXPENSE', status: 'ACTIVE' },
    { code: '493', name: 'Travel - National', type: 'EXPENSE', status: 'ACTIVE' },
    { code: '494', name: 'Travel - International', type: 'EXPENSE', status: 'ACTIVE' },
    { code: '200', name: 'Sales', type: 'REVENUE', status: 'ACTIVE' },
    { code: '499', name: 'Travel', type: 'EXPENSE', status: 'ARCHIVED' },
  ];

  test('every category has hints, and the hints only name listed categories', () => {
    for (const c of CATEGORY_NAMES) expect(CATEGORY_HINTS[c]).toBeTruthy();
  });

  test("maps Solv categories onto Xero's default Singapore chart", () => {
    expect(accountForCategory('Lodging', chart)).toBe('494');
    expect(accountForCategory('Air & Transport', chart)).toBe('493');
    expect(accountForCategory('Meals', chart)).toBe('420');
    expect(accountForCategory('Phone', chart)).toBe('489');
    expect(accountForCategory('Fuel/Mileage', chart)).toBe('449');
    expect(accountForCategory('Office Supplies', chart)).toBe('461');
    expect(accountForCategory('Software/Utilities', chart)).toBe('485');
    expect(accountForCategory('Other', chart)).toBe('429');
  });

  test('never picks revenue or an archived account; no match is null', () => {
    expect(accountForCategory('Lodging', [{ code: '200', name: 'Travel', type: 'REVENUE', status: 'ACTIVE' }])).toBeNull();
    expect(accountForCategory('Medical/Dental', chart)).toBeNull();
    expect(accountForCategory('Nope', chart)).toBeNull();
    expect(accountForCategory('Lodging', [])).toBeNull();
  });
});
