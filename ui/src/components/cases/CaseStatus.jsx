import StatusBadge from '../StatusBadge';

// A case's status as a badge: Draft, Open, Claimed, and "Ready" for an open
// case that passes the claim's checks, which is what its owner wants to know
// at a glance. Ready is green, the colour a done step has on the Stepper; it
// is still an open case, and the words say so to a screen reader.
//
// Props:
//   status  'draft' | 'open' | 'claimed'.
//   ready   the list's `ready`, or caseFacts().ready on the case page.
export default function CaseStatus({ status, ready = false }) {
  if (status === 'open' && ready) {
    return (
      <span className="badge badge-green" title="Every receipt is checked and priced: it can be claimed">
        Ready<span className="sr-only"> to claim</span>
      </span>
    );
  }
  return <StatusBadge status={status} />;
}
