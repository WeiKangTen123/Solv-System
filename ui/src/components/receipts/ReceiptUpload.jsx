import { useEffect, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start at the route AFTER it.
// Writing '/api/receipts' would request '/api/api/receipts' and 404.
import { api } from '../../api/client';
import { prepareReceipt, blobToBase64, humanSize, ACCEPT_ATTR } from './receipt-upload';
import PhonePairingModal from './PhonePairingModal';
import ClaimImport from './ClaimImport';

// Add-receipt controls for AR & AP. Expense claims are the only document type
// the user creates by hand — bills and invoices arrive by email on their own —
// so this is the one place in the list that needs an input affordance.
//
// Nothing here talks to Xero. An uploaded receipt becomes a local record for the
// user to review.
// `reportId` points every upload at one case, which is what makes the case
// screen work: the receipts go in where you are standing, instead of into the
// loose pile to be filed again later.
export default function ReceiptUpload({ onUploaded, reportId = null }) {
  // An import survives closing the panel, and GET /claims/active is how you
  // find it again: without this the progress view, the reconciliation summary
  // and the Undo button were gone for good the moment the dialog was closed.
  const [runningJobId, setRunningJobId] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/claims/active')
      .then(d => { if (alive) setRunningJobId((d.jobs || d.active || []).map(j => j.id || j.jobId)[0] || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const fileRef = useRef(null);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');
  const [note, setNote]     = useState('');
  const [pairing, setPairing] = useState(false);
  const [importing, setImporting] = useState(false);

  async function handleFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;

    setBusy(true);
    setError('');
    setNote('');
    const failures = [];
    let ok = 0;

    for (const file of list) {
      try {
        const { blob, mime, originalBytes, bytes } = await prepareReceipt(file);
        const data = await blobToBase64(blob);
        await api.post('/receipts', { mime, data, filename: file.name, source: 'upload', ...(reportId ? { reportId } : {}) });
        ok++;
        // Worth saying out loud: a 9MB photo becoming 700KB is the difference
        // between Xero accepting the attachment and rejecting it.
        if (bytes < originalBytes) {
          setNote(`Compressed ${humanSize(originalBytes)} → ${humanSize(bytes)} to fit Xero's 3MB attachment limit.`);
        }
      } catch (err) {
        failures.push(`${file.name}: ${err.message}`);
      }
    }

    setBusy(false);
    if (failures.length) setError(failures.join(' · '));
    if (ok && onUploaded) onUploaded();
    if (fileRef.current) fileRef.current.value = '';  // let the same file be picked again
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        style={{ display: 'none' }}
        onChange={e => handleFiles(e.target.files)}
      />

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          style={{ background: 'var(--accent-subtle)', color: 'var(--accent-ink)', border: '1px solid var(--accent)', whiteSpace: 'nowrap' }}
        >
          {busy ? 'Uploading…' : '+ Add expense'}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setImporting(true)}
          style={{ whiteSpace: 'nowrap' }}
          title="Import a zip of receipts with its claim form, as emailed"
        >
          Import a claim
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setPairing(true)}
          style={{ whiteSpace: 'nowrap' }}
          title="Scan a code to photograph expense claims with your phone"
        >
          Use my phone
        </button>
      </div>

      {note && !error && (
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)', maxWidth: 340, textAlign: 'right', lineHeight: 1.45 }}>{note}</span>
      )}
      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.25)',
          borderRadius: 8,
          padding: '7px 12px',
          fontSize: 12,
          color: 'var(--danger)',
          maxWidth: 360,
          textAlign: 'left',
          lineHeight: 1.45,
          marginTop: 2,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 6,
        }}>
          <span style={{ fontSize: 13, lineHeight: 1 }}>⚠</span>
          <span>{error}</span>
        </div>
      )}

      {pairing && (
        <PhonePairingModal onClose={() => setPairing(false)} onArrived={onUploaded} reportId={reportId} />
      )}

      {importing && (
        <ClaimImport onClose={() => setImporting(false)} onImported={onUploaded} initialJobId={runningJobId} />
      )}
    </div>
  );
}
