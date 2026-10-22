import { useEffect, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import Modal from '../Modal';
import { fmtMoney } from '../../utils/format';

// "Post to Xero": the bill as it would be sent (POST /post?dryRun=1, which
// sends nothing), then the question, then the bill. The preview and the
// question used to be two buttons, and the bill could be posted without
// anyone looking at it; here it is on screen when the question is asked.
//
// The bill is for what is owed, after advances: the total before them was
// what the question once named, a different figure from the one posted.
//
// Props:
//   report        the case: id, number, ownerName, totals.reimbursement.
//   base          the company's currency.
//   tenantName    the Xero organisation, if known.
//   onPosted      async fn(): the page loads the case again.
//   onClose       fn().
export default function PostDialog({ report, base, tenantName, onPosted, onClose }) {
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.post(`/reports/${report.id}/post?dryRun=1`, {})
      .then(d => { if (alive) setPreview(d); })
      .catch(err => { if (alive) setPreviewError(err.message); });
    return () => { alive = false; };
  }, [report.id]);

  async function post() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api.post(`/reports/${report.id}/post`, {});
      await onPosted();
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
      // A failed post is recorded on the case (its Xero error), so the page
      // behind shows it too.
      onPosted().catch(() => {});
    }
  }

  const bill = preview && preview.bill;
  return (
    <Modal onClose={onClose} busy={busy} maxWidth={560} labelledBy="cs-post-title">
      <div id="cs-post-title" className="cs-dialog-title">Post {report.number} to Xero?</div>
      <p className="cs-dialog-text">
        A draft bill payable to {report.ownerName || 'the claimant'} for {fmtMoney(report.totals && report.totals.reimbursement, base)} will be
        created in {tenantName || 'Xero'}, with the receipts attached. It is approved in Xero as usual.
      </p>

      <div className="cs-bill" aria-live="polite">
        {previewError ? (
          <div className="alert alert-warning">The preview could not be made: {previewError}</div>
        ) : !bill ? (
          <div className="cs-sub">Building the bill…</div>
        ) : (
          <>
            <div className="cs-bill-head">
              Bill to {bill.contact.name} · {bill.invoice.currencyCode} {fmtMoney(bill.total)} · {preview.tenantName || tenantName || 'no organisation'}
            </div>
            <ul className="cs-bill-lines">
              {bill.invoice.lineItems.map((l, i) => (
                <li key={i}>
                  <span className="cs-bill-desc">{l.description}</span>
                  <span className="cs-sub">{l.accountCode || '—'} · {l.taxType}</span>
                  <span className="cs-num">{fmtMoney(l.unitAmount)}</span>
                </li>
              ))}
            </ul>
            <div className="cs-sub">Attachments: {(bill.attachments || []).join(', ') || 'none'}</div>
          </>
        )}
      </div>

      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="cs-dialog-buttons">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={post} disabled={busy} aria-busy={busy}>
          {busy ? 'Posting…' : 'Post to Xero'}
        </button>
      </div>
    </Modal>
  );
}
