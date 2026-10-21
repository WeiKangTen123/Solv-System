// A row of filter buttons that narrow a list: "Needs a look", "Not in a case",
// a kind, a person. Unlike Tabs they do not switch to another view, so they
// are plain toggle buttons (aria-pressed) and Tab walks through each one.
//
// Single choice by default: `value` is the chosen id, and pressing the chosen
// chip again leaves it chosen (put an "All" option first for "no filter").
// With `multiple`, `value` is an array of ids and each press adds or removes
// one; an empty array means no filter.
//
// Props:
//   options   [{ id, label, count? }]. `count` is a muted figure after the
//             label, read as "Duplicates, 2".
//   value     the chosen id, or with `multiple` an array of ids.
//   onChange  fn(id) or, with `multiple`, fn(ids[]).
//   multiple  allow more than one at once.
//   label     aria-label for the group ("Filter receipts").
export default function FilterChips({ options, value, onChange, multiple = false, label }) {
  const chosen = multiple ? new Set(value || []) : null;
  const isOn = id => (multiple ? chosen.has(id) : value === id);

  function press(id) {
    if (!multiple) { if (value !== id) onChange?.(id); return; }
    // Kept in the options' order, so the same filters always read the same way.
    const next = isOn(id) ? [...chosen].filter(x => x !== id) : [...chosen, id];
    onChange?.(options.map(o => o.id).filter(x => next.includes(x)));
  }

  return (
    <div role="group" aria-label={label} className="ui-chips">
      {options.map(o => {
        const on = isOn(o.id);
        return (
          <button key={o.id} type="button" aria-pressed={on} className={`ui-chip${on ? ' is-on' : ''}`} onClick={() => press(o.id)}>
            <span>{o.label}</span>
            {o.count != null && <span className="ui-count"><span className="sr-only">, </span>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
