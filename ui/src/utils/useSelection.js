import { useCallback, useEffect, useRef, useState } from 'react';

// Which rows of a list are ticked, for a table with bulk actions ("Move 3 to
// case…", "Delete 3"). Pass the ids of the rows on screen, in order.
//
// A row that leaves the list (deleted, moved, filtered out, the next page)
// leaves the selection too. Otherwise "3 selected" could count a row nobody
// can see any more, and the bulk action would quietly act on it.
//
//   const sel = useSelection(rows.map(r => r.id));
//   <Checkbox checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label="Select all" />
//   <Checkbox checked={sel.isSelected(r.id)} onChange={on => sel.toggle(r.id, on)} label={`Select ${r.merchant}`} />
//   {sel.count > 0 && <button onClick={() => move(sel.selected)}>Move {sel.count}…</button>}
//
// Returns:
//   selected    the ticked ids, in the list's order.
//   count       how many.
//   all, some   every row ticked; some but not all (for the header box).
//   isSelected  fn(id).
//   toggle      fn(id, on?): flips it, or sets it when `on` is given.
//   selectAll, clear, toggleAll (all when not all, else none).
export function useSelection(ids = []) {
  const [picked, setPicked] = useState(() => new Set());
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const key = ids.join('\u0000');

  useEffect(() => {
    setPicked(prev => {
      const keep = new Set(idsRef.current.filter(id => prev.has(id)));
      return keep.size === prev.size ? prev : keep;
    });
  }, [key]);

  const toggle = useCallback((id, on) => setPicked(prev => {
    const next = new Set(prev);
    if (on === undefined ? !next.has(id) : on) next.add(id); else next.delete(id);
    return next;
  }), []);
  const selectAll = useCallback(() => setPicked(new Set(idsRef.current)), []);
  const clear = useCallback(() => setPicked(new Set()), []);
  const toggleAll = useCallback(() => setPicked(prev => {
    const ids = idsRef.current;
    return ids.length && ids.every(id => prev.has(id)) ? new Set() : new Set(ids);
  }), []);

  const selected = ids.filter(id => picked.has(id));
  const count = selected.length;
  return {
    selected, count,
    all: ids.length > 0 && count === ids.length,
    some: count > 0 && count < ids.length,
    isSelected: id => picked.has(id),
    toggle, selectAll, clear, toggleAll,
  };
}
