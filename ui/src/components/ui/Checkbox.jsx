import { useEffect, useRef } from 'react';

// A checkbox for picking rows in a table, with the third state the header box
// needs: "some rows picked" (indeterminate), which exists only as a DOM
// property and cannot be written as an attribute in JSX. Pair it with
// utils/useSelection.js.
//
// The rows it sits in open a receipt or a case on click and on Enter or
// Space, so its clicks and those two keys stop here: ticking a row must not
// also open it. On a phone the box keeps a 44px target around it.
//
// Props:
//   checked        ticked.
//   indeterminate  some but not all (only shown while not `checked`).
//   onChange       fn(checked, event).
//   label          accessible name ("Select Grab, 2 Sep"; "Select all").
//                  Required unless `children` gives visible words.
//   children       optional visible words beside the box.
//   disabled, id   as on any input.
export default function Checkbox({ checked, indeterminate = false, onChange, label, children, disabled, id }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <label className="ui-check" onClick={e => e.stopPropagation()}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}>
      <input ref={ref} id={id} type="checkbox" checked={!!checked} disabled={disabled}
             aria-label={children ? undefined : label} onChange={e => onChange?.(e.target.checked, e)} />
      {children && <span>{children}</span>}
    </label>
  );
}
