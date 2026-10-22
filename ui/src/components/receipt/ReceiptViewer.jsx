import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import CroppedImage from '../receipts/CroppedImage';
import Modal from '../Modal';

// The receipt itself, beside the fields read from it: a photo (or the region
// of a shared photo that is this receipt), or the page of a PDF it is on.
//
// Props:
//   receipt   { id, mime, pages } (expense.receipt), or null for no file.
//   page      the PDF page this receipt is on (expense.page).
//   box       the region of a shared photo (expense.box), or null.
//   token     optional image token the page already has (GET /expenses/:id
//             hands one out); without it one is asked for.
//   height    the picture's height (CSS); defaults to filling the parent.
//   tools     optional buttons for the toolbar (Re-read).
//   caption   optional words after "Photo · 2 pages" (who read it).
//   variant   'full' (default) or 'thumb': a small picture that opens the
//             full viewer over the whole screen, for a phone.
//
// Zoom and rotate change the view only; nothing is saved. Give it a `key` of
// the expense id, so each receipt opens fitted and upright.
const ZOOMS = ['fit', 1, 1.5, 2, 3];

// Links already made, per receipt. Each lasts five minutes on the server and
// is used for four: going back to a receipt shows it again without asking
// for a new link, and the browser serves the picture from its cache because
// the address is the same.
const LINK_LIFE_MS = 4 * 60 * 1000;
const _links = new Map();
const _url = (id, token) => `/api/receipts/${id}/image?token=${encodeURIComponent(token)}`;

export function useReceiptLink(receiptId, token) {
  const [state, setState] = useState({ url: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!receiptId) { setState({ url: null, error: null }); return undefined; }
    const hit = _links.get(receiptId);
    if (hit && Date.now() - hit.at < LINK_LIFE_MS) { setState({ url: hit.url, error: null }); return undefined; }
    if (token && !attempt) {
      const url = _url(receiptId, token);
      _links.set(receiptId, { url, at: Date.now() });
      setState({ url, error: null });
      return undefined;
    }
    let alive = true;
    setState({ url: null, error: null });
    api.get(`/receipts/${receiptId}/token`)
      .then(d => {
        if (!alive) return;
        const url = _url(receiptId, d.token);
        _links.set(receiptId, { url, at: Date.now() });
        setState({ url, error: null });
      })
      .catch(e => { if (alive) setState({ url: null, error: e.message }); });
    return () => { alive = false; };
    // The token is only for the first link: a page that polls hands a new one
    // out each time, and renewing on every poll downloaded the whole receipt
    // again every two and a half seconds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptId, attempt]);
  // A link that stopped working (expired while the tab slept) is made again.
  const retry = useCallback(() => { _links.delete(receiptId); setAttempt(a => a + 1); }, [receiptId]);
  return { ...state, retry };
}

// Opened inside the click so the browser allows it, then pointed at a freshly
// signed link: the one on screen may be older than its five minutes.
export async function openReceipt(receiptId) {
  const w = window.open('', '_blank');
  if (w) w.opener = null;
  try {
    const d = await api.get(`/receipts/${receiptId}/token`);
    const url = _url(receiptId, d.token);
    if (w) w.location.href = url; else window.location.href = url;
  } catch (e) {
    if (w) w.close();
    throw e;
  }
}

export default function ReceiptViewer({ receipt, page, box, token, height, tools, caption, variant = 'full' }) {
  const { url, error, retry } = useReceiptLink(receipt ? receipt.id : null, token);
  const [zoom, setZoom] = useState('fit');
  const [rot, setRot] = useState(0);
  const [broken, setBroken] = useState(false);
  const [full, setFull] = useState(false);
  const [openError, setOpenError] = useState(null);
  const isPdf = receipt?.mime === 'application/pdf';
  const at = ZOOMS.indexOf(zoom);
  const onBroken = useCallback(() => setBroken(true), []);
  const again = () => { setBroken(false); retry(); };
  // The drawn picture's own size, read off the canvas once it is drawn: a
  // picture turned on its side needs a box of the turned shape around it.
  const stageRef = useRef(null);
  const [drawn, setDrawn] = useState(null);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof MutationObserver === 'undefined') return undefined;
    const read = () => {
      const c = stage.querySelector('canvas');
      if (c && c.width > 1 && c.height > 1) setDrawn(d => (d && d.w === c.width && d.h === c.height ? d : { w: c.width, h: c.height }));
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(stage, { subtree: true, childList: true, attributes: true, attributeFilter: ['width', 'height'] });
    return () => watch.disconnect();
  }, [url, variant]);

  async function openOriginal() {
    setOpenError(null);
    try { await openReceipt(receipt.id); } catch (e) { setOpenError(e.message); }
  }

  if (variant === 'thumb') {
    return (
      <>
        <button type="button" className="rcpt-thumb" onClick={() => setFull(true)} disabled={!receipt}
                aria-label={receipt ? 'Show the receipt full screen' : 'No receipt file'}>
          {!receipt ? <span className="rcpt-thumb-note">No file</span>
            : isPdf ? <span className="rcpt-thumb-note">PDF{page ? ` · page ${page}` : ''}</span>
            : url && !broken ? <CroppedImage src={url} box={box} alt="Receipt" style={{ maxWidth: '100%', maxHeight: '100%' }} onError={onBroken} />
            : <span className="rcpt-thumb-note">{error || broken ? 'Could not load it here' : 'Loading…'}</span>}
          {receipt && <span className="rcpt-thumb-hint" aria-hidden="true">Tap to enlarge</span>}
        </button>
        {full && (
          <Modal sheet onClose={() => setFull(false)} label="Receipt" maxWidth={900} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setFull(false)}>Close</button>
            </div>
            <ReceiptViewer receipt={receipt} page={page} box={box} token={token} height="calc(100vh - 150px)" />
          </Modal>
        )}
      </>
    );
  }

  const describe = receipt
    ? `${isPdf ? 'PDF' : 'Photo'}${receipt.pages ? ` · ${receipt.pages} page${receipt.pages === 1 ? '' : 's'}` : ''}${page ? ` · page ${page}` : ''}`
    : 'No file';
  const turned = rot % 180 !== 0;
  const spin = rot ? `rotate(${rot}deg)` : undefined;
  // Fitted, the picture is as large as the panel allows; zoomed, it is a
  // share of the panel's width and the panel scrolls.
  const picture = zoom === 'fit'
    ? { maxWidth: '100%', maxHeight: '100%', transform: spin }
    : { width: `${zoom * 100}%`, maxWidth: 'none', flex: 'none', transform: spin };
  // Turned on its side, a transform alone leaves the page's unturned box
  // behind: a tall receipt turned sideways ran off both edges, and zoomed it
  // scrolled over empty space. So the turned picture gets a box of its own,
  // `across` wide (container units: a share of the panel) and the turned
  // shape tall, and the canvas is turned in the middle of it.
  let image = null;
  if (url && !isPdf && turned && drawn) {
    const ratio = drawn.h / drawn.w;            // the turned picture's width over its height
    const across = zoom === 'fit' ? `min(100cqw, 100cqh * ${ratio})` : `${zoom * 100}cqw`;
    image = (
      <div className="rcpt-turned" style={{ width: across, aspectRatio: `${drawn.h} / ${drawn.w}` }}>
        <CroppedImage src={url} box={box} alt="Receipt" onError={onBroken}
                      style={{ width: `calc(${across} / ${ratio})`, height: across, transform: `translate(-50%, -50%) ${spin}` }} />
      </div>
    );
  } else if (url && !isPdf) {
    image = <CroppedImage src={url} box={box} alt="Receipt" onError={onBroken} style={picture} />;
  }

  return (
    <div className="rcpt-viewer" style={height ? { height } : undefined}>
      <div className="rcpt-toolbar">
        <div className="rcpt-caption">{describe}{caption ? ` · ${caption}` : ''}</div>
        <div className="rcpt-tools">
          {url && (
            <div className="rcpt-zoom" role="group" aria-label="Zoom">
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setZoom(ZOOMS[Math.max(0, at - 1)])} disabled={at <= 0} aria-label="Zoom out" title="Zoom out">−</button>
              <button type="button" className="btn btn-outline btn-sm rcpt-zoom-level" onClick={() => setZoom('fit')} disabled={zoom === 'fit'} title="Fit to the panel">
                {zoom === 'fit' ? 'Fit' : `${zoom * 100}%`}
              </button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, at + 1)])} disabled={at >= ZOOMS.length - 1} aria-label="Zoom in" title="Zoom in">+</button>
            </div>
          )}
          {/* A PDF turns in the browser's own viewer; turning the frame round
              it turned its scroll bars too. */}
          {url && !isPdf && <button type="button" className="btn btn-outline btn-sm" onClick={() => setRot(r => (r + 90) % 360)} title="Rotate the view (nothing is saved)">Rotate</button>}
          {tools}
          {receipt && <button type="button" className="btn btn-outline btn-sm" onClick={openOriginal} title="Open the original in a new tab">Open ↗</button>}
        </div>
      </div>
      {openError && <div className="alert alert-error" style={{ margin: '0 0 8px' }}>{openError}</div>}
      <div ref={stageRef} className={`rcpt-stage${zoom === 'fit' ? ' is-fit' : ''}${isPdf ? ' is-pdf' : ''}`}>
        {!receipt ? <div className="rcpt-empty">No receipt file.</div>
          : error || broken ? (
            <div className="rcpt-empty">
              The receipt could not be shown{error ? `: ${error}` : '.'}{' '}
              <button type="button" className="btn btn-outline btn-sm" onClick={again}>Try again</button>
            </div>
          )
          : !url ? <div className="rcpt-empty">Loading the receipt…</div>
          // The frame is drawn again for a new zoom: the browser's viewer reads
          // its zoom from the address only when it opens.
          : isPdf ? <iframe key={String(zoom)} title="Receipt" src={`${url}#page=${page || 1}&zoom=${zoom === 'fit' ? 'page-width' : zoom * 100}`} />
          : image}
      </div>
    </div>
  );
}
