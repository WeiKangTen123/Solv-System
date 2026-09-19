// The currencies Solv offers by name, in the order a Singapore company meets
// them. One list, used three ways: the reader matches these codes when it
// reads a document as text, the company endpoint serves them to the currency
// picker, and the exchange-rate page offers them when finance types a rate.
//
// It is a convenience, never a limit. `currencyCode()` accepts any three-letter
// code the AI reader returns, a claimant can type one that is not here, and the
// rate providers between them cover about 160 currencies — so a receipt from
// somewhere nobody has been yet still prices correctly.
//
// `zeroDecimal` marks the currencies that print no minor unit: a yen amount is
// ¥12,345, not ¥12,345.00. Amounts are still stored to the cent, because the
// converted figure needs them.
const CURRENCIES = [
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'MYR', name: 'Malaysian ringgit' },
  { code: 'IDR', name: 'Indonesian rupiah', zeroDecimal: true },
  { code: 'THB', name: 'Thai baht' },
  { code: 'VND', name: 'Vietnamese dong', zeroDecimal: true },
  { code: 'PHP', name: 'Philippine peso' },
  { code: 'INR', name: 'Indian rupee' },
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'Pound sterling' },
  { code: 'JPY', name: 'Japanese yen', zeroDecimal: true },
  { code: 'CNY', name: 'Chinese yuan' },
  { code: 'HKD', name: 'Hong Kong dollar' },
  { code: 'TWD', name: 'New Taiwan dollar' },
  { code: 'KRW', name: 'South Korean won', zeroDecimal: true },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'NZD', name: 'New Zealand dollar' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'CHF', name: 'Swiss franc' },
  { code: 'AED', name: 'UAE dirham' },
  { code: 'SAR', name: 'Saudi riyal' },
  { code: 'QAR', name: 'Qatari riyal' },
  { code: 'ZAR', name: 'South African rand' },
  { code: 'BND', name: 'Brunei dollar' },
  { code: 'KHR', name: 'Cambodian riel', zeroDecimal: true },
  { code: 'MMK', name: 'Myanmar kyat', zeroDecimal: true },
  { code: 'LAK', name: 'Lao kip', zeroDecimal: true },
  { code: 'MOP', name: 'Macanese pataca' },
  { code: 'LKR', name: 'Sri Lankan rupee' },
  { code: 'BDT', name: 'Bangladeshi taka' },
  { code: 'PKR', name: 'Pakistani rupee' },
  { code: 'NPR', name: 'Nepalese rupee' },
];

const CURRENCY_CODES = CURRENCIES.map(c => c.code);
const ZERO_DECIMAL = CURRENCIES.filter(c => c.zeroDecimal).map(c => c.code);

module.exports = { CURRENCIES, CURRENCY_CODES, ZERO_DECIMAL };
