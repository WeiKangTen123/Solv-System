import { useCallback, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import ConfirmDialog from '../components/ConfirmDialog';

// The pages on screen that can have unsaved edits, each with a way to ask.
// Signing out is not a move the router can hold, so the sign-out button asks
// here instead.
const _pages = new Set();
export function hasUnsavedEdits() {
  for (const dirty of _pages) if (dirty()) return true;
  return false;
}

// Asks before leaving a page with edits that have not been saved: a link, the
// sidebar, the breadcrumb, the browser's back button, or closing the tab.
// Prev and Next on a receipt used to be the only moves that asked; anything
// else dropped what had been typed without a word.
//
// `isDirty` is a function, called at the moment of leaving, so a page can keep
// its flag in a ref. Returns the question to render while one is open, or null.
export function useLeaveGuard(isDirty, message = 'What you typed here has not been saved.') {
  const latest = useRef(isDirty);
  latest.current = isDirty;
  const dirty = useCallback(() => !!latest.current(), []);

  // A change of page or of query asks; a change that stays on the same address
  // (a hash, a state push) does not.
  const blocker = useBlocker(useCallback(({ currentLocation: from, nextLocation: to }) =>
    dirty() && (from.pathname !== to.pathname || from.search !== to.search), [dirty]));

  // Closing the tab or reloading: the browser asks, in its own words.
  useEffect(() => {
    const onUnload = e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onUnload);
    _pages.add(dirty);
    return () => { window.removeEventListener('beforeunload', onUnload); _pages.delete(dirty); };
  }, [dirty]);

  if (blocker.state !== 'blocked') return null;
  return (
    <ConfirmDialog title="Leave without saving?" message={message} confirmLabel="Leave" danger
                   onConfirm={() => blocker.proceed()} onCancel={() => blocker.reset()} />
  );
}
