import { useEffect, useRef } from 'react';

// Calls `fn` when something elsewhere in the app has changed the data behind
// the page: the assistant fires 'solv:changed' after it applies an edit. Only
// the case and receipt pages listened, so a list behind the assistant went on
// showing the old figures until the next poll, up to half a minute later.
//
// An answer that applies several edits fires one event each; they are
// gathered into one reload.
export function useOnChanged(fn, wait = 300) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });

  useEffect(() => {
    let timer = null;
    const on = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { Promise.resolve(fnRef.current()).catch(() => {}); }, wait);
    };
    window.addEventListener('solv:changed', on);
    return () => { clearTimeout(timer); window.removeEventListener('solv:changed', on); };
  }, [wait]);
}
