// What the server noticed about a receipt (receipts/flags.js): red stops the
// claim and reads "Must fix"; yellow is "Have a look" and does not. Red comes
// first. Each level has its own mark as well as its colour (! and ?), so the
// two can be told apart without seeing colour.
//
// Full, it lists the flags under the two headings. `compact` is for a table
// cell: one pill in the colour of the worst flag with how many there are,
// whose tooltip (and screen-reader text) lists them all.
//
// Props:
//   flags     [{ code, level: 'red' | 'yellow', text, field? }]. Empty or
//             missing renders nothing.
//   compact   the count pill instead of the list.
//   onSelect  optional fn(flag): each flag becomes a button, for a page that
//             can take the person to the field the flag is about (`field`).
const LEVELS = [
  { level: 'red', title: 'Must fix', mark: '!' },
  { level: 'yellow', title: 'Have a look', mark: '?' },
];

export default function FlagList({ flags, compact = false, onSelect }) {
  const list = Array.isArray(flags) ? flags : [];
  if (!list.length) return null;
  // Anything not red is a "have a look": an unknown level must not pass for
  // one that stops the claim, nor vanish.
  const groups = LEVELS
    .map(l => ({ ...l, items: list.filter(f => (f.level === 'red') === (l.level === 'red')) }))
    .filter(g => g.items.length);

  if (compact) {
    const words = groups.map(g => `${g.title}: ${g.items.map(f => f.text).join('; ')}`);
    return (
      <span className={`ui-flag-pill is-${groups[0].level}`} title={words.join('\n')}>
        <span aria-hidden="true">{groups[0].mark} {list.length}</span>
        <span className="sr-only">{words.join('. ')}</span>
      </span>
    );
  }

  return (
    <div className="ui-flags">
      {groups.map(g => (
        <div key={g.level} className={`ui-flag-group is-${g.level}`}>
          <div className="ui-flag-title">{g.title}</div>
          <ul>
            {g.items.map((f, i) => (
              <li key={`${f.code}-${i}`} className="ui-flag">
                <span className="ui-flag-mark" aria-hidden="true">{g.mark}</span>
                {onSelect
                  ? <button type="button" className="ui-flag-text ui-flag-link" onClick={() => onSelect(f)}>{f.text}</button>
                  : <span className="ui-flag-text">{f.text}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
