import { useEffect, useSyncExternalStore } from 'react';

// The header's breadcrumb trail is worked out from the address alone, and the
// address cannot know everything: /expenses/abc is "My receipts › Check" for a
// receipt on its own, but the receipt may sit in case C-0012, and then the way
// back is the case. A page that knows better says so here, and the header
// shows that trail while the page is on screen at that address.
//
// Kept for the address it was set on, so a trail can never outlive its page
// and show on the next one.
let current = null;          // { path, crumbs: [{ label, to? }] }
const listeners = new Set();
const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const snapshot = () => current;
const tell = () => listeners.forEach(fn => fn());

// In a page: usePageCrumbs(location.pathname, [{ label: 'Cases', to: '/reports' }, { label: 'C-0012', to: '/reports/1' }, { label: 'Check' }]).
// null or undefined leaves the header to work it out from the address.
export function usePageCrumbs(path, crumbs) {
  const key = crumbs ? JSON.stringify(crumbs) : '';
  useEffect(() => {
    if (!key) return undefined;
    const mine = { path, crumbs: JSON.parse(key) };
    current = mine;
    tell();
    return () => { if (current === mine) { current = null; tell(); } };
  }, [path, key]);
}

// In the header: the trail a page set for this address, or null.
export function usePageCrumbsFor(pathname) {
  const set = useSyncExternalStore(subscribe, snapshot);
  return set && set.path === pathname ? set.crumbs : null;
}
