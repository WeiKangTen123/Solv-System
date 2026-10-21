import { useEffect, useId, useRef, useState } from 'react';

// A button that opens a short list of actions: "Export ▾" (PDF, Excel, CSV),
// "Move to case…" (one item per open case). It is the ARIA menu button:
//
//   - Enter, Space or Down opens it on the first item; Up opens it on the last.
//   - Up and Down move (and wrap), Home and End jump; disabled items are
//     skipped. Enter or Space chooses.
//   - Escape closes it and puts focus back on the button; so does choosing,
//     before onSelect runs, so a dialog opened from an item returns focus to
//     the button when it closes. Tab closes it and moves on. A click anywhere
//     else closes it.
//
// It opens downwards, or upwards when there is no room below (a bar pinned to
// the bottom of a phone screen). It is positioned against the button, so keep
// it out of containers that scroll sideways, such as a wide table's wrapper.
//
// Props:
//   label      the button's text (nodes allowed); a ▾ is added.
//   items      [{ label, onSelect, disabled?, hint?, danger? }]. `hint` is a
//              quieter second line ("1–4 Sep 2026"); `danger` colours it red.
//   align      'start' (default) or 'end': which edge of the button the list
//              lines up with. Use 'end' for a button at the right of a row.
//   className  the button's classes (default "btn btn-outline btn-sm").
//   disabled   the button cannot be opened.
//   empty      what an empty list says (default "Nothing to choose").
const choosable = el => Array.from(el?.querySelectorAll('[role="menuitem"]:not(:disabled)') || []);

export default function Menu({ label, items, align = 'start', className = 'btn btn-outline btn-sm', disabled = false, empty = 'Nothing to choose' }) {
  const id = `menu-${useId().replace(/:/g, '')}`;
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const startAt = useRef('first');
  const list = items && items.length ? items : [{ label: empty, disabled: true }];

  function show(where) {
    if (disabled) return;
    startAt.current = where;
    // Room below the button for a list of a few items; otherwise above, if
    // there is more room there.
    const r = btnRef.current?.getBoundingClientRect();
    setUp(!!r && window.innerHeight - r.bottom < 260 && r.top > window.innerHeight - r.bottom);
    setOpen(true);
  }
  function hide(refocus) {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }

  // Focus goes into the list once it is drawn.
  useEffect(() => {
    if (!open) return;
    const all = choosable(listRef.current);
    (startAt.current === 'last' ? all[all.length - 1] : all[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  function onButtonKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); show('first'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); show('last'); }
  }

  function onListKey(e) {
    const all = choosable(listRef.current);
    const at = all.indexOf(document.activeElement);
    const go = i => { e.preventDefault(); all[(i + all.length) % all.length]?.focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Escape') {
      // Stopped here, so a dialog around the menu does not close as well.
      e.preventDefault(); e.stopPropagation(); hide(true);
    } else if (e.key === 'Tab') {
      // Focus is moved to the button first and the Tab carries on from
      // there; the items are out of the tab order, so it lands on whatever
      // follows the button.
      btnRef.current?.focus();
      setOpen(false);
    }
  }

  function choose(item) {
    hide(true);
    item.onSelect?.();
  }

  return (
    <div className="ui-menu-wrap" ref={wrapRef}>
      <button ref={btnRef} type="button" className={className} disabled={disabled}
              aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
              onClick={() => (open ? hide(false) : show('first'))} onKeyDown={onButtonKey}>
        {label} <span className="ui-menu-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div ref={listRef} id={id} role="menu" className={`ui-menu${align === 'end' ? ' is-end' : ''}${up ? ' is-up' : ''}`} onKeyDown={onListKey}>
          {list.map((it, i) => (
            <button key={i} type="button" role="menuitem" tabIndex={-1} disabled={!!it.disabled}
                    className={`ui-menu-item${it.danger ? ' is-danger' : ''}`} onClick={() => choose(it)}>
              <span className="ui-menu-label">{it.label}</span>
              {it.hint && <span className="ui-menu-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
