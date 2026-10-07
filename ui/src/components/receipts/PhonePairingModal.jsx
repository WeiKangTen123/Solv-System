import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../Modal';
import { api } from '../../api/client';
import { fmtMoney } from '../../utils/format';
import { useVisiblePolling } from '../../utils/useVisiblePolling';

// A thumbnail's image link is good for five minutes (routes/receipts.js).
// Each one keeps its link for four, then takes the fresh one the next poll
// brings: renewing on every poll downloaded every thumbnail again every three
// seconds, and never renewing left a dialog open past five minutes with links
// the server refused.
const LINK_KEEP_MS = 4 * 60 * 1000;

// The device-pairing pattern people already know from WhatsApp Web and banking
// apps: a big scannable code, numbered steps, and visible confirmation.
//
// The thumbnails are the point. A counter saying "3 received" makes you look
// away to the table to check it really worked; seeing the photo you just took
// appear is the confirmation itself.
//
// Blocking the page costs nothing here — while pairing you are holding a phone,
// not using the desktop.
export default function PhonePairingModal({ onClose, onArrived, reportId = null }) {
  const [pair, setPair]       = useState(null);
  const [receipts, setRcpts]  = useState([]);
  const [secsLeft, setSecs]   = useState(0);
  const [spent, setSpent]     = useState(false);
  const [error, setError]     = useState('');
  // The parent's callback, held in a ref: passed inline it was a new function
  // on every parent render, and as an effect dependency it tore the poll down
  // and started it again each time.
  const arrivedRef = useRef(onArrived);
  arrivedRef.current = onArrived;
  const seenRef = useRef(0);
  // Each photo's image link and when it was taken: receipt id -> { token, at }.
  const linkRef = useRef({});
  // Set once the code can take nothing more and every photo it took has been
  // read: from then on the answer cannot change, so the poll stops asking.
  const doneRef = useRef(false);

  // Mint the pairing once, on open.
  useEffect(() => {
    let active = true;
    api.post('/receipts/pair', reportId ? { reportId } : {})
      .then(res => { if (active) { setPair(res); setSecs(Math.round(res.expiresInMs / 1000)); } })
      .catch(err => { if (active) setError(err.message || 'Could not create a pairing code'); });
    return () => { active = false; };
    // One code per opening, for the case it was opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for arrivals. One request carries the countdown, the count and the
  // photos, so the panel needs nothing else. It runs only while the tab is
  // looked at, like every other poll in the app.
  const poll = useCallback(async () => {
    if (!pair || doneRef.current) return;
    try {
      const s = await api.get(`/receipts/pair/${pair.token}`);
      setSecs(Math.max(0, Math.round(s.expiresInMs / 1000)));
      setSpent(!!s.spent);
      const list = s.receipts || [];
      // The list only grows. Once a code has expired the server forgets it
      // and answers with no photos, which is not the photos going away.
      if (list.length >= seenRef.current) {
        const now = Date.now();
        for (const r of list) {
          const had = linkRef.current[r.id];
          if (r.imageToken && (!had || now - had.at > LINK_KEEP_MS)) linkRef.current[r.id] = { token: r.imageToken, at: now };
        }
        // Parsed fields arrive over later polls, so replace wholesale rather
        // than appending — a row's merchant and total fill in as they are read.
        // The arrival is announced outside the state update: React may run
        // an updater twice, and the parent then counted every photo twice.
        if (list.length !== seenRef.current) { seenRef.current = list.length; arrivedRef.current?.(); }
        setRcpts(list);
      }
      // An expired or used-up code gets no more photos, but the last few may
      // still be being read; stop asking once they are.
      if ((s.expiresInMs <= 0 || s.spent) && list.every(r => r.parsed)) doneRef.current = true;
    } catch { /* transient — the next tick tries again */ }
  }, [pair]);
  useEffect(() => { poll(); }, [poll]);
  useVisiblePolling(poll, 3000);

  // Revoke on close so a code that was on screen dies immediately rather than
  // lingering for the rest of its ten minutes. The parent is handed the
  // revocation: it may delete the case this session made, and only once the
  // link is dead can it know nothing more is on its way.
  function close() {
    const token = pair?.token;
    const revoked = token ? api.delete(`/receipts/pair/${token}`).catch(() => { /* it expires anyway */ }) : Promise.resolve();
    onClose({ revoked });
  }

  const mmss = `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}`;
  const expired = secsLeft <= 0 && !!pair;

  const steps = [
    'Open the camera app on your phone',
    'Point it at this code and tap the link',
    'Photograph your receipts — no login needed',
  ];

  return (
    <Modal onClose={close} maxWidth={430} label="Scan with your phone">

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Scan with your phone</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
              Photograph receipts straight into the case.
            </div>
          </div>
          <button onClick={close} aria-label="Close"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 22, lineHeight: 1, padding: 2 }}>×</button>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 14 }}><span className="alert-icon">✕</span>{error}</div>}

        {!pair && !error && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 240, gap: 10, color: 'var(--text-muted)', fontSize: 13 }}>
            <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
            Creating a code…
          </div>
        )}

        {pair && (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
              <div style={{ background: '#fff', padding: 12, borderRadius: 12, lineHeight: 0,
                            // An expired code must not look scannable.
                            opacity: expired ? 0.25 : 1, transition: 'opacity .2s ease' }}>
                {/* An image from the server, never markup injected into the page. */}
                <img src={pair.qr} alt="QR code to open the capture page on your phone" width={220} height={220} />
              </div>
            </div>

            <ol style={{ margin: '0 0 16px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {steps.map((text, i) => (
                <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: '50%', background: 'var(--bg-secondary)',
                                 color: 'var(--text-muted)', fontSize: 10.5, fontWeight: 700,
                                 display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                  {text}
                </li>
              ))}
            </ol>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                          padding: '10px 0', borderTop: '1px solid var(--border)', fontSize: 12 }}>
              <span style={{ color: expired ? 'var(--danger)' : 'var(--text-muted)' }}>
                {expired ? 'Code expired' : `⏱ Expires in ${mmss}`}
              </span>
              <span style={{ color: receipts.length ? 'var(--success)' : 'var(--text-muted)' }}>
                {receipts.length
                  ? `✓ ${receipts.length} received`
                  : <><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', marginRight: 7, animation: 'pulse 1.4s ease-in-out infinite' }} />Waiting for a photo…</>}
              </span>
            </div>

            {receipts.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 12 }}>
                {receipts.map(r => (
                  <div key={r.id} style={{ width: 76 }}>
                    <div style={{ width: 76, height: 76, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-secondary)',
                                  border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {/* 76px tiles, so they ask for a 160px copy — 2x for a
                          retina screen — rather than the stored receipt, which
                          can be 3MB. The server falls back to the original if it
                          cannot scale, so this never fails to show a photo. */}
                      <img src={`/api/receipts/${r.id}/image?w=160&token=${encodeURIComponent(linkRef.current[r.id]?.token || r.imageToken)}`}
                           alt="" loading="lazy" decoding="async" width={76} height={76}
                           style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    {/* Fills in a poll or two later, once the image has been read.
                        A photo the reader could not make out used to say
                        "Reading…" for ever; the server says when it is done,
                        and whether anything came of it, as the phone shows. */}
                    <div title={r.parsed && r.unreadable ? 'Saved, but the reader could not make it out. Fill it in yourself.' : undefined}
                         style={{ fontSize: 11, color: r.parsed && r.unreadable ? 'var(--warning)' : 'var(--text-muted)', marginTop: 4, textAlign: 'center',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {!r.parsed ? 'Reading…'
                        : r.unreadable ? 'Not read'
                        : r.total ? fmtMoney(r.total, r.currency || '') : (r.merchant || 'Amount not read')}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {(expired || spent) && (
              <button className="btn btn-primary btn-sm" onClick={close} style={{ marginTop: 14, width: '100%' }}>
                Done — close and show a new code if you need one
              </button>
            )}
          </>
        )}

        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 16, paddingTop: 12,
                      borderTop: '1px solid var(--border)', lineHeight: 1.55 }}>
          The link uploads only — it cannot read your data, and it stops working when you close this.
        </div>
    </Modal>
  );
}
