import { useEffect, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import { useConfirm } from '../../context/ConfirmContext';

// The person's own address for forwarding receipts by email
// (main/routes/inbound.js): receipts+<token>@<the company's mail domain>.
// The mail provider hands each message to the server, which takes it only
// when it was sent from this person's own address, and files it in the case
// its subject names, if any.
//
// The address is made the first time it is asked for. A new one replaces it
// at once, for someone whose old one reached the wrong people. A server that
// does not take mail says so in one line, with no address to copy.
//
// Props:
//   email  the person's own address, the one mail must come from.
export default function InboundAddress({ email }) {
  const confirm = useConfirm();
  const [state, setState] = useState(null);     // { address, configured }
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  const addressRef = useRef(null);

  useEffect(() => {
    let alive = true;
    api.get('/users/me/inbound-address')
      .then(d => { if (alive) setState(d); })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  async function copy() {
    setCopied('');
    try {
      await navigator.clipboard.writeText(state.address);
      setCopied('Copied.');
    } catch {
      // No clipboard (an insecure page, a refusal): the address is selected
      // instead, for the person to copy themselves.
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(addressRef.current);
      sel.removeAllRanges();
      sel.addRange(range);
      setCopied('Selected: press Ctrl+C (⌘C on a Mac) to copy it.');
    }
  }

  async function renew() {
    const ok = await confirm({
      title: 'Make a new address?',
      message: 'The address you have now stops working at once: mail sent to it is no longer filed. Anywhere you have saved it, use the new one instead.',
      confirmLabel: 'Make a new address', danger: true,
    });
    if (!ok) return;
    setBusy(true); setError(''); setCopied('');
    try {
      const d = await api.post('/users/me/inbound-address', {});
      setState(s => ({ ...s, address: d.address, configured: true }));
      setCopied('New address made. The old one no longer works.');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="card pol-card">
      <div className="card-title">Email receipts to</div>
      {error && <div className="alert alert-error pol-alert" role="alert">{error}</div>}
      {!state ? (!error && <div className="pol-muted">Loading…</div>)
        : !state.configured || !state.address ? (
          <div className="pol-muted">Your company has not set up receipts by email yet.</div>
        ) : (
          <>
            <div className="card-subtitle pol-sub">
              Forward an e-receipt, or send a photo or PDF of one, to your own address below. It is read like any receipt you add here.
            </div>
            <div className="pol-inbound">
              <code ref={addressRef} className="pol-address" id="pol-inbound-address">{state.address}</code>
              <span className="pol-inbound-actions">
                <button type="button" className="btn btn-outline btn-sm" onClick={copy} aria-describedby="pol-inbound-address">Copy</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={renew} disabled={busy}>{busy ? 'Making…' : 'New address'}</button>
              </span>
            </div>
            <div className="sr-only" role="status" aria-live="polite">{copied}</div>
            {copied && <div className="pol-hint pol-copied" aria-hidden="true">{copied}</div>}
            <ul className="pol-rules">
              <li>Only mail sent from {email ? <strong>{email}</strong> : 'your own address'} is taken; anything else is dropped.</li>
              <li>Put a case number, such as <span className="cs-mono">EXP-2026-0002</span>, in the subject to file the receipts in that open case. Without one they wait on Home under &ldquo;Not in a case&rdquo;.</li>
            </ul>
          </>
        )}
    </div>
  );
}
