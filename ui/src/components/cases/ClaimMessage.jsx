import { declarationFor } from '../../utils/declaration';

// What the "Mark claimed" window says: what claiming does, and the declaration
// the claimant makes by going on. The claim is sent with `declared: true`, and
// the case PDF then says it was declared in Solv. Used by the case page and
// the review page, so both ask the same thing.
export default function ClaimMessage({ company }) {
  return (
    <>
      Do this once the claim has gone through your company. Its receipts are then locked; you can reopen it until it is posted to Xero.
      <div style={{ marginTop: 12, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>By marking it claimed, you declare:</div>
      <blockquote style={{ margin: '6px 0 0', padding: '10px 12px', borderLeft: '3px solid var(--accent)', background: 'var(--bg-secondary)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12.5, lineHeight: 1.5 }}>
        {declarationFor(company)}
      </blockquote>
    </>
  );
}
