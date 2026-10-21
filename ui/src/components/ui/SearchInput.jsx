import { useEffect, useId, useRef, useState } from 'react';

// A search box for a list that asks the server: it waits until typing pauses
// (`delay`) before calling onChange, so "taxi" is one request, not four. The
// box itself answers every key at once; only the call waits.
//
// The ✕ button and Escape clear it straight away. Escape on an empty box is
// left alone, so it still closes whatever dialog the box is in. Enter sends
// what is typed without waiting. A value changed from outside (a "Clear
// filters" button) replaces what is in the box.
//
// It always has a label: `label`, else the placeholder, else "Search". It is
// visually hidden, because the box explains itself, but a screen reader names
// it, and a placeholder alone disappears the moment typing starts.
//
// Props:
//   value        the search the list is using now.
//   onChange     fn(text), called after the pause, on Enter, or on clearing.
//   placeholder  hint inside the box ("Search merchant, case, number").
//   delay        ms to wait after the last key (default 250).
//   label        accessible name, when the placeholder is not the right one.
//   id           optional id for the input.
export default function SearchInput({ value, onChange, placeholder, delay = 250, label, id }) {
  const auto = useId();
  const inputId = id || `search-${auto.replace(/:/g, '')}`;
  const [text, setText] = useState(value ?? '');
  const sent = useRef(value ?? '');
  const timer = useRef(null);
  const inputRef = useRef(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  // Only a value that did not come from this box replaces what is typed: the
  // page echoing back the last search must not undo the keys pressed since.
  useEffect(() => {
    const v = value ?? '';
    if (v === sent.current) return;
    sent.current = v;
    clearTimeout(timer.current);
    setText(v);
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function send(v) {
    clearTimeout(timer.current);
    if (v === sent.current) return;
    sent.current = v;
    onChangeRef.current?.(v);
  }
  function type(v) {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => send(v), delay);
  }
  function clear() {
    setText('');
    send('');
    inputRef.current?.focus();
  }
  function onKeyDown(e) {
    if (e.key === 'Escape' && text) { e.preventDefault(); e.stopPropagation(); clear(); }
    else if (e.key === 'Enter') { e.preventDefault(); send(text); }
  }

  return (
    <div className="ui-search">
      <label className="sr-only" htmlFor={inputId}>{label || placeholder || 'Search'}</label>
      <span className="ui-search-icon" aria-hidden="true">⌕</span>
      <input ref={inputRef} id={inputId} type="search" className="form-input" autoComplete="off" spellCheck={false}
             value={text} placeholder={placeholder} onChange={e => type(e.target.value)} onKeyDown={onKeyDown} />
      {text && (
        <button type="button" className="ui-search-clear" onClick={clear} aria-label="Clear the search">
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </div>
  );
}
