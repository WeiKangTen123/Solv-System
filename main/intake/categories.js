// The expense categories a claim can carry — ONE list, used by:
//   * receipts/receipt-parser.js   — the prompt offers exactly these names
//   * the company's report columns default to these names (store/users.js)
//   * normalise() in the parser  — anything the model returns outside the list is dropped
//
// Names match the headings on the company's claim form, so a category here is
// also a column there. The scope line is what the model is told each one means;
// keep it about WHAT was bought and WHEN, never about why.
const CATEGORIES = [
  { name: 'Air & Transport',    scope: 'flights, trains, taxis, ride-hailing, public transport, parking, tolls' },
  { name: 'Lodging',            scope: 'hotel rooms and accommodation, including room taxes and service charges' },
  { name: 'Meals',              scope: 'breakfast, lunch, dinner, room service, cafe and food delivery, including their taxes' },
  { name: 'Entertainment',      scope: 'client entertainment, events, hospitality' },
  { name: 'Phone',              scope: 'mobile, roaming, SIM cards, internet and telecom bills' },
  { name: 'Fuel/Mileage',       scope: 'petrol, diesel, EV charging, mileage claims' },
  { name: 'Office Supplies',    scope: 'stationery, printer toner, desk accessories, minor equipment' },
  { name: 'Software/Utilities', scope: 'cloud servers, software subscriptions, utilities' },
  { name: 'Medical/Dental',     scope: 'clinic visits, prescription medicine, dental checkups' },
  { name: 'Other',              scope: 'courier, postage, bank charges, visa fees, and anything that fits nowhere else' },
];

const CATEGORY_NAMES = CATEGORIES.map(c => c.name);

// "staff  welfare", "Entertainment / Meals" and "SOFTWARE/UTILITIES" all mean
// a listed category; a model is allowed to be sloppy about case and spacing,
// not about which categories exist.
const _key = v => String(v).toLowerCase().replace(/\s+and\s+/g, ' & ').replace(/\s*([/&])\s*/g, '$1').replace(/[.:]+$/, '').replace(/\s+/g, ' ').trim();
// The words a reader uses for a listed category instead of its name. A hotel
// line it called "Accommodation", or a ride it called "Taxi", was dropped as
// an invented category and the line fell back to whatever the receipt was.
// Only words that mean one category: "Gas" (fuel or a utility?) and
// "Groceries" (a meal or supplies?) are left out on purpose.
const SYNONYMS = {
  'Lodging': ['hotel', 'hotels', 'accommodation', 'accommodations', 'accomodation', 'lodging & accommodation', 'room', 'rooms', 'room charge', 'room charges'],
  'Air & Transport': ['transport', 'transportation', 'taxi', 'taxis', 'ride', 'rides', 'ride-hailing', 'travel', 'airfare', 'air fare', 'air', 'flight', 'flights', 'train', 'bus', 'parking', 'toll', 'tolls', 'public transport', 'air/transport'],
  'Meals': ['food', 'f&b', 'food & beverage', 'food & beverages', 'food & drink', 'meal', 'dining', 'restaurant', 'breakfast', 'lunch', 'dinner', 'beverages', 'drinks', 'meals & entertainment', 'room service'],
  'Entertainment': ['client entertainment', 'hospitality', 'events'],
  'Phone': ['telephone', 'mobile', 'telecom', 'telecommunications', 'telco', 'internet', 'roaming'],
  'Fuel/Mileage': ['fuel', 'petrol', 'diesel', 'mileage', 'ev charging'],
  'Office Supplies': ['stationery', 'office', 'office supply', 'supplies'],
  'Software/Utilities': ['software', 'utilities', 'subscription', 'subscriptions', 'saas', 'cloud'],
  'Medical/Dental': ['medical', 'dental', 'clinic', 'pharmacy', 'medicine', 'health'],
  'Other': ['others', 'misc', 'miscellaneous', 'sundry', 'sundries'],
};
const _byKey = new Map(CATEGORIES.map(c => [_key(c.name), c.name]));
for (const [name, words] of Object.entries(SYNONYMS)) for (const w of words) if (!_byKey.has(_key(w))) _byKey.set(_key(w), name);
function canonicalCategory(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return _byKey.get(_key(value)) || null;
}

module.exports = { CATEGORIES, CATEGORY_NAMES, canonicalCategory };
