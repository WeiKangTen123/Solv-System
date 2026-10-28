import { useRef, useState } from 'react';
import { api } from '../../api/client';

// The logo printed on a case PDF's cover and at the top of its pages
// (main/reports/expense-pdf.js). It saves as soon as it is chosen, on its own
// like the policy and per-diem cards, and says so beside its own button. The
// server keeps a small PNG of it laid on white (routes/company.js).
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 2 * 1024 * 1024;

const readAsDataUrl = file => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('That file could not be read.'));
  r.readAsDataURL(file);
});

export default function CompanyLogo({ logo, onSaved }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  async function choose(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;
    if (!TYPES.includes(file.type)) { setNote({ tone: 'error', text: 'Choose a PNG, JPEG or WebP picture.' }); return; }
    if (file.size > MAX_BYTES) { setNote({ tone: 'error', text: 'The logo is over 2 MB. Choose a smaller picture.' }); return; }
    setBusy(true); setNote(null);
    try {
      const out = await api.post('/company/logo', { dataUri: await readAsDataUrl(file) });
      onSaved(out.company);
      setNote({ tone: 'success', text: 'Logo saved. Case PDFs carry it from now on.' });
    } catch (err) { setNote({ tone: 'error', text: err.message }); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      const out = await api.delete('/company/logo');
      onSaved(out.company);
      setNote({ tone: 'success', text: 'Logo removed. Case PDFs show the company name instead.' });
    } catch (err) { setNote({ tone: 'error', text: err.message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="card">
      <div className="card-title">Logo for exported PDFs</div>
      <div className="card-subtitle">Printed on the cover and at the top of every page of a case PDF. PNG, JPEG or WebP, up to 2 MB; a wide logo on a white or clear background prints best.</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {/* White, as the page it prints on is, whatever the theme. */}
        <div style={{ width: 220, maxWidth: '100%', height: 72, border: '1px dashed var(--border)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#ffffff', padding: 8 }}>
          {logo
            ? <img src={logo} alt="Company logo" style={{ maxWidth: '100%', maxHeight: 54, objectFit: 'contain' }} />
            : <span style={{ fontSize: 12, color: '#6b7280', textAlign: 'center' }}>No logo yet: the company name prints instead</span>}
        </div>
        <input ref={input} type="file" accept={TYPES.join(',')} onChange={choose} hidden />
        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Saving…' : logo ? 'Replace logo' : 'Upload logo'}
        </button>
        {logo && <button type="button" className="btn btn-ghost" disabled={busy} onClick={remove}>Remove</button>}
      </div>
      {note && <div className={`alert alert-${note.tone} pol-alert`} role={note.tone === 'error' ? 'alert' : 'status'} style={{ marginTop: 12 }}>{note.text}</div>}
    </div>
  );
}
