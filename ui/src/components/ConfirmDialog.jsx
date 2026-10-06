import { useState } from 'react';
import Modal from './Modal';

// A yes/no question with a real button for each answer. Replaces the native
// confirm(), which blocks the whole tab, cannot be styled, and on some phones
// is silently suppressed after the first one.
//
// While the confirmed action runs, both buttons are disabled and the dialog
// cannot be dismissed: a second click used to send the request twice.
export default function ConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false);
  async function confirm() {
    if (busy) return;
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  }
  return (
    <Modal onClose={onCancel} busy={busy} maxWidth={420} zIndex={1100} label={title} style={{ padding: '24px 26px' }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
      {message && <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>{message}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={confirm} disabled={busy} aria-busy={busy} autoFocus
                style={danger ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' } : undefined}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
