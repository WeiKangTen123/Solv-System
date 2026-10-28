// The currencies Solv offers by name, in the order a Singapore company meets
// them. One list, used four ways: the reader matches these codes when it
// reads a document as text, the company endpoint serves them to the currency
// picker, the exchange-rate page offers them when finance types a rate, and
// the live board groups its currencies by `region`.
//
// It is a convenience, never a limit. `currencyCode()` accepts any real ISO
// code the AI reader returns, a claimant can type one that is not here, and the
// rate providers between them cover about 160 currencies — so a receipt from
// somewhere nobody has been yet still prices correctly.
//
// `zeroDecimal` marks the currencies that print no minor unit: a yen amount is
// ¥12,345, not ¥12,345.00. Amounts are still stored to the cent, because the
// converted figure needs them.
//
// `region` is where the board lists it: 'asia', 'west' (Europe and the
// Americas) or 'other'. A code not in this list is 'other'.
const CURRENCIES = [
  { code: 'SGD', name: 'Singapore dollar', region: 'asia' },
  { code: 'MYR', name: 'Malaysian ringgit', region: 'asia' },
  { code: 'IDR', name: 'Indonesian rupiah', region: 'asia', zeroDecimal: true },
  { code: 'THB', name: 'Thai baht', region: 'asia' },
  { code: 'VND', name: 'Vietnamese dong', region: 'asia', zeroDecimal: true },
  { code: 'PHP', name: 'Philippine peso', region: 'asia' },
  { code: 'INR', name: 'Indian rupee', region: 'asia' },
  { code: 'USD', name: 'US dollar', region: 'west' },
  { code: 'EUR', name: 'Euro', region: 'west' },
  { code: 'GBP', name: 'Pound sterling', region: 'west' },
  { code: 'JPY', name: 'Japanese yen', region: 'asia', zeroDecimal: true },
  { code: 'CNY', name: 'Chinese yuan', region: 'asia' },
  { code: 'HKD', name: 'Hong Kong dollar', region: 'asia' },
  { code: 'TWD', name: 'New Taiwan dollar', region: 'asia' },
  { code: 'KRW', name: 'South Korean won', region: 'asia', zeroDecimal: true },
  { code: 'AUD', name: 'Australian dollar', region: 'other' },
  { code: 'NZD', name: 'New Zealand dollar', region: 'other' },
  { code: 'CAD', name: 'Canadian dollar', region: 'west' },
  { code: 'CHF', name: 'Swiss franc', region: 'west' },
  { code: 'AED', name: 'UAE dirham', region: 'other' },
  { code: 'SAR', name: 'Saudi riyal', region: 'other' },
  { code: 'QAR', name: 'Qatari riyal', region: 'other' },
  { code: 'ZAR', name: 'South African rand', region: 'other' },
  { code: 'BND', name: 'Brunei dollar', region: 'asia' },
  { code: 'KHR', name: 'Cambodian riel', region: 'asia', zeroDecimal: true },
  { code: 'MMK', name: 'Myanmar kyat', region: 'asia', zeroDecimal: true },
  { code: 'LAK', name: 'Lao kip', region: 'asia', zeroDecimal: true },
  { code: 'MOP', name: 'Macanese pataca', region: 'asia' },
  { code: 'LKR', name: 'Sri Lankan rupee', region: 'asia' },
  { code: 'BDT', name: 'Bangladeshi taka', region: 'asia' },
  { code: 'PKR', name: 'Pakistani rupee', region: 'asia' },
  { code: 'NPR', name: 'Nepalese rupee', region: 'asia' },
];

const CURRENCY_CODES = CURRENCIES.map(c => c.code);

// The currencies on a company's exchange-rate board from the start: where a
// Singapore company's staff most often spend, by Changi's busiest markets and
// routes and Singapore's largest trading partners — eight in Asia, the euro
// and the US dollar. Every one is published by the European Central Bank, so
// each has its history from the day it is added. An admin changes the list;
// a currency removed from it stays removed.
const DEFAULT_BOARD = ['MYR', 'IDR', 'THB', 'CNY', 'JPY', 'HKD', 'INR', 'PHP', 'EUR', 'USD'];
// How many currencies an admin may choose for the board. Currencies receipts
// use are on it as well, whatever the number: they are what is being priced.
const BOARD_MAX = 10;

const _byCode = new Map(CURRENCIES.map(c => [c.code, c]));
const regionOf = code => (_byCode.get(code) || {}).region || 'other';

// A currency's English name: from the list, or from the platform's own table
// for any other code (a receipt in Czech koruna still gets a name).
let _names = null;
function currencyName(code) {
  const known = _byCode.get(code);
  if (known) return known.name;
  try {
    _names = _names || new Intl.DisplayNames(['en'], { type: 'currency' });
    const name = _names.of(code);
    return name && name !== code ? name : null;
  } catch { return null; }
}

module.exports = { CURRENCIES, CURRENCY_CODES, DEFAULT_BOARD, BOARD_MAX, regionOf, currencyName };
