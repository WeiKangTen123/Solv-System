import { useVisiblePolling } from '../../utils/useVisiblePolling';

// Calls `fn` every `every` ms while the tab is looked at (useVisiblePolling).
//
// The hook re-paces by itself when `every` drops, so a read that starts on a
// page that opened idle is followed at once. Callers still render this keyed
// on the interval, <Poll key={every} …/>, which also restarts the count when
// the pace slows, and costs nothing.
export default function Poll({ fn, every }) {
  useVisiblePolling(fn, every);
  return null;
}
