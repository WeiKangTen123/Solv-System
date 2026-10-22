import { useVisiblePolling } from '../../utils/useVisiblePolling';

// Calls `fn` every `every` ms while the tab is looked at (useVisiblePolling).
//
// The hook reads its interval only when it schedules the next call, so a
// page that opened with nothing being read waited out its long interval (30 s
// on a case, a minute on the list) before it noticed a read had started, and
// as long again before it showed the read land. Render it keyed on the
// interval, <Poll key={every} …/>, and it starts again at the new pace the
// moment the pace changes.
export default function Poll({ fn, every }) {
  useVisiblePolling(fn, every);
  return null;
}
