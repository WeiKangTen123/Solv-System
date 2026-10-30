const fs   = require('fs');
const path = require('path');

// Whether a receipt's rows add up to its total is asked on the receipt page
// (ui/src/utils/printed.js, the quiet "These come to 27.85, 0.30 under the
// total" line) and on the server (main/receipts/printed.js), with one rule
// for the currency's step. A page that called rows short which the server
// called whole, or the other way round, would ask a person to fix what is
// not broken. So each case is put to both.
//
// The UI file is an ES module and jest here runs CommonJS, so it is loaded
// from its source with its `export` keywords taken off, which only works
// while it imports nothing.
const FILE = path.join(__dirname, '../../ui/src/utils/printed.js');
function loadUi() {
  const src = fs.readFileSync(FILE, 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('utils/printed.js imports something now; this test can only load a module that does not');
  const body = src.replace(/^export\s+(?=(async\s+function|function|const|let|class)\s)/gm, '');
  return new Function(`${body}\nreturn { addsUp, step };`)();
}
// Until the screens' branch is merged the file is not here, and there is
// nothing to hold the server to; once it is, every case runs.
const PRESENT = fs.existsSync(FILE);
const UI = PRESENT ? loadUi() : null;
const SERVER = require('../receipts/printed');

const row = (kind, label, amount, x = {}) => ({ kind, label, amount, qty: null, unitPrice: null, rate: null, included: false, worked: false,
  category: null, onBehalfOf: null, taxRate: null, on: null, ...x });
const nasi = [row('item', 'Nasi Kandar', 14.5), row('item', 'Roti Canai', 3), row('item', 'Teh Tarik', 6.4),
              row('charge', 'Service Charge', 2.39, { rate: 10 }), row('tax', 'SST', 1.58, { rate: 6 }), row('rounding', 'Rounding Adj', -0.02)];

const CASES = [
  ['the nasi kandar bill, to the cent', 'MYR', { rows: nasi, total: 27.85 }],
  ['the same bill 0.30 short', 'MYR', { rows: nasi, total: 28.15 }],
  ['a rounding row leaves only a cent', 'MYR', { rows: nasi, total: 27.87 }],
  ['5 sen off with no rounding row, in ringgit', 'MYR', { rows: [row('item', 'Lunch', 10)], total: 10.05 }],
  ['5 cents off in euros', 'EUR', { rows: [row('item', 'Lunch', 10)], total: 10.05 }],
  ['2 cents off in euros', 'EUR', { rows: [row('item', 'Lunch', 10)], total: 10.02 }],
  ['a rupee off', 'INR', { rows: [row('item', 'Room', 10000)], total: 10001 }],
  ['ten won off', 'KRW', { rows: [row('item', 'Bibimbap', 12000)], total: 12010 }],
  ['a hundred rupiah off', 'IDR', { rows: [row('item', 'Nasi Goreng', 196300)], total: 196400 }],
  ['a thousand dong off', 'VND', { rows: [row('item', 'Pho', 65000)], total: 66000 }],
  ['an included GST is not added', 'SGD', { rows: [row('item', 'Rice', 13.8), row('tax', 'GST', 1.14, { rate: 9, included: true })], total: 13.8 }],
  ['an included GST read as added', 'SGD', { rows: [row('item', 'Rice', 13.8), row('tax', 'GST', 1.14, { rate: 9 })], total: 13.8 }],
  ['a folio\'s per-charge taxes carry half a percent', 'INR', { rows: [row('item', 'Room', 10000), row('tax', 'CGST', 900, { rate: 9, on: 0 }), row('tax', 'SGST', 900, { rate: 9, on: 0 })], total: 11830 }],
  ['...and not more', 'INR', { rows: [row('item', 'Room', 10000), row('tax', 'CGST', 900, { rate: 9, on: 0 }), row('tax', 'SGST', 900, { rate: 9, on: 0 })], total: 11900 }],
  ['a tax under a tax is not per charge', 'INR', { rows: [row('item', 'Room', 10000), row('tax', 'CGST', 900, { rate: 9 }), row('tax', 'SGST', 900, { rate: 9, on: 1 })], total: 11830 }],
  ['a tax under a row that is not there is not per charge', 'INR', { rows: [row('item', 'Room', 10000), row('tax', 'GST', 1800, { rate: 18, on: 9 })], total: 11830 }],
  ['a discount typed without its minus takes off', 'SGD', { rows: [row('item', 'Fare', 23.4), row('discount', 'Promo', 2)], total: 21.4 }],
  ['a discount with its minus', 'SGD', { rows: [row('item', 'Fare', 23.4), row('discount', 'Promo', -2)], total: 21.4 }],
  ['no rows at all', 'SGD', { rows: [], total: 21.4 }],
  ['amounts typed as text', 'USD', { rows: [row('item', 'Steak', '99.00'), row('tax', 'Sales Tax', '8.54', { rate: 8.625 })], total: '107.54' }],
  ['a total of nothing', 'USD', { rows: [row('item', 'Steak', 99)], total: 0 }],
];

(PRESENT ? describe : describe.skip)('the rows add up on the page exactly when they do on the server', () => {
  test.each(CASES)('%s', (name, currency, printed) => {
    const ui = UI.addsUp(printed, currency);
    const server = SERVER.addsUp(printed, currency);
    expect({ ok: ui.ok, sum: ui.sum, gap: ui.gap }).toEqual(server);
  });

  test('the currency\'s step is one rule', () => {
    for (const c of ['MYR', 'myr', 'SGD', 'INR', 'JPY', 'KRW', 'IDR', 'VND', 'EUR', 'USD', 'THB', '', null, undefined]) expect(UI.step(c)).toBe(SERVER.step(c));
  });
});
