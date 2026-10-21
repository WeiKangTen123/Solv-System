// What a case is, in the words the screen uses.
//
// The database keeps `trip | period | case`, and so does the API; people see
// Trip / Month / Other. "Period" read as accounting jargon, and "Case" as the
// kind of a case said nothing at all, so the screen names them for what they
// hold. Every page that shows or picks a kind reads it from here, so the three
// words cannot drift apart between the list, the case page and the form.
//
// The glyphs are plain text characters, not emoji: they take the colour of the
// text around them and look the same on every platform.
//
// No imports, so main/scripts/ui-format-dates.test.js can load it from source.

export const KINDS = ['trip', 'period', 'case'];

export const KIND_LABEL = { trip: 'Trip', period: 'Month', case: 'Other' };

// One line under the kind picker, saying when to choose it.
export const KIND_HINT = {
  trip: 'Travel away from home: the dates you were away and where you went.',
  period: 'One calendar month of local claims, such as taxis and meals.',
  case: 'Anything else: receipts claimed together under one name.',
};

// Not the bottom nav's glyphs (▦ ▤ ◧ ◈), so a kind never looks like a tab.
export const KIND_GLYPH = { trip: '↗', period: '◫', case: '◇' };

// An unknown kind (an older row, a typo in a test) shows as itself rather than
// as nothing.
export function kindLabel(kind) {
  return KIND_LABEL[kind] || (kind ? String(kind) : KIND_LABEL.case);
}
