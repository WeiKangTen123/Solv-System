import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { prepareReceipt, blobToBase64, postWithProgress, PHOTO_ACCEPT_ATTR } from '../components/receipts/receipt-upload';
import ProgressBar from '../components/ui/ProgressBar';
// Only a timer that pauses in a hidden tab: it asks nothing of a session, so
// it serves this signed-out page as well as any other.
import { useVisiblePolling } from '../utils/useVisiblePolling';

// The page a phone lands on after scanning the QR code shown on the desktop.
//
// Deliberately outside the auth guard: the pairing token in the URL is the only
// credential, which is the entire point — nobody types a password on a phone to
// photograph a receipt. That token grants upload and nothing else, so this page
// can never list, read or delete anything.
//
// Two ways in: Take photo opens the camera for one picture (iOS hands back a
// single photo when the camera is asked for, whatever `multiple` says), and
// Choose photos opens the library for several at once. Each photo gets a row
// at once and they go up one after another, so a slow link shows how far each
// has got rather than one spinner for the lot.
//
// The link's limits, as main/receipts/pairing.js sets them (TTL_MS, MAX_USES):
// open for thirty minutes after the last photo, fifty photos in all. The page
// says the same, so nobody is surprised by "Link expired" mid-stack.
const LINK_MINUTES = 30;
const LINK_PHOTOS = 50;
const EXPIRED = 'This link has expired. Show a new QR code on your computer.';

const capturePath = token => `/receipts/capture/${encodeURIComponent(token)}`;
const SENDING = new Set(['waiting', 'preparing', 'sending']);

export default function Capture() {
  const { token } = useParams();
  const cameraRef = useRef(null);
  const pickRef = useRef(null);
  const [state, setState] = useState('checking'); // checking | ready | expired
  // The case these photos go into, shown at the top so nobody shoots ten
  // receipts into the wrong one. A draft has no number yet.
  const [target, setTarget] = useState(null);
  const [usesLeft, setUses] = useState(null);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');

  // What the sender works from, outside React's render: the order photos
  // were picked in, the files themselves (kept until sent, for Try again),
  // and how many more the link takes.
  const queue = useRef([]);
  const files = useRef(new Map());
  const working = useRef(false);
  const left = useRef(null);
  const dead = useRef(false);
  const count = useRef(0);

  // Checked before a camera button is shown, so an expired link says so
  // instead of failing after the photo has been taken.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/receipts/capture/${encodeURIComponent(token)}`)
      .then(r => r.json().then(b => ({ ok: r.ok, b })))
      .then(({ ok, b }) => {
        if (cancelled) return;
        if (!ok || !b.ok) { setState('expired'); setError(b.error || 'This link is no longer valid.'); return; }
        left.current = typeof b.usesLeft === 'number' ? b.usesLeft : null;
        setUses(left.current);
        setTarget(b.case || null);
        setState('ready');
      })
      .catch(() => { if (!cancelled) { setState('expired'); setError('Could not reach the server.'); } });
    return () => { cancelled = true; };
  }, [token]);

  const patch = useCallback((key, p) => setItems(list => list.map(it => (it.key === key ? { ...it, ...p } : it))), []);

  async function sendOne(key) {
    const file = files.current.get(key);
    if (!file) return;
    if (dead.current) { patch(key, { state: 'failed', words: 'Not sent: the link has expired.', retry: false }); return; }
    // Past the link's last photo nothing is sent, rather than each one
    // failing as "expired".
    if (left.current === 0) { patch(key, { state: 'over' }); return; }
    patch(key, { state: 'preparing', words: '', retry: false });
    let prepared, data;
    try {
      prepared = await prepareReceipt(file);
      data = await blobToBase64(prepared.blob);
    } catch (err) {
      patch(key, { state: 'failed', words: err.message, retry: false });
      return;
    }
    patch(key, { state: 'sending', progress: 0 });
    let res;
    try {
      res = await postWithProgress(capturePath(token), { mime: prepared.mime, data, filename: file.name },
        { onProgress: p => patch(key, { progress: p }) });
    } catch (err) {
      // Nothing came back: the signal dropped. The photo is still here.
      patch(key, { state: 'failed', words: err.message, retry: true });
      return;
    }
    const { status, body } = res;
    if (status === 201) {
      if (left.current !== null) left.current = Math.max(0, left.current - 1);
      setUses(left.current);
      files.current.delete(key);
      patch(key, { state: 'sent', id: body.receipt && body.receipt.id, progress: 1 });
      return;
    }
    if (status === 401) {
      // The link died under the stack: the rest cannot go either.
      dead.current = true;
      patch(key, { state: 'failed', words: 'Not sent: the link has expired.', retry: false });
      setState('expired');
      setError(body.error || EXPIRED);
      return;
    }
    const dup = status === 409 && ('duplicateOf' in body || /already uploaded/i.test(body.error || ''));
    patch(key, dup
      ? { state: 'duplicate', words: body.error || 'This receipt was sent before.' }
      : { state: 'failed', words: body.error || 'The upload failed.', retry: status >= 500 || status === 429 });
  }

  // One at a time, in the order picked: a phone's upload link is the narrow
  // part, and several at once only make each one slower to show progress.
  async function pump() {
    if (working.current) return;
    working.current = true;
    try {
      while (queue.current.length) await sendOne(queue.current.shift());
    } finally {
      working.current = false;
    }
  }

  function add(list) {
    const picked = Array.from(list || []);
    if (!picked.length) return;
    setError('');
    const fresh = picked.map(f => {
      count.current += 1;
      const key = `p${count.current}`;
      files.current.set(key, f);
      // The thumbnail is the file the phone already holds. Fetching the image
      // back would mean granting this link the ability to READ receipts.
      let preview = null;
      try { preview = URL.createObjectURL(f); } catch { preview = null; }
      return { key, n: count.current, preview, state: 'waiting', progress: 0, words: '' };
    });
    // Newest batch on top, where the thumb that just took it can see it.
    setItems(prev => [...fresh, ...prev]);
    queue.current.push(...fresh.map(it => it.key));
    pump();
  }

  function retry(key) {
    patch(key, { state: 'waiting', words: '', retry: false });
    queue.current.push(key);
    pump();
  }

  // Reading happens after the upload answers, so what was read arrives a
  // moment later. Asked only while something sent is still unread.
  const statusGone = useRef(false);
  const poll = async () => {
    if (state !== 'ready' || statusGone.current || !items.some(it => it.id && !it.parsed)) return;
    try {
      const res = await fetch(`/api/receipts/capture/${encodeURIComponent(token)}/status`);
      if (res.status === 401) {
        // Asking again would only be told the same thing.
        statusGone.current = true;
        setState('expired');
        setError(EXPIRED);
        return;
      }
      if (!res.ok) return;
      const body = await res.json();
      if (body.usesLeft === 0 || body.spent) { left.current = 0; setUses(0); }
      const byId = new Map((body.receipts || []).map(r => [r.id, r]));
      setItems(list => list.map(it => {
        const got = it.id ? byId.get(it.id) : null;
        return got ? { ...it, parsed: got.parsed, unreadable: got.unreadable, merchant: got.merchant, total: got.total, currency: got.currency } : it;
      }));
    } catch { /* a moment without signal; the next tick asks again */ }
  };
  useVisiblePolling(poll, 4000);

  // The previews hold the photos in memory until released, which happens
  // once, when the page goes away; released on every change, the thumbnails
  // on screen lost their pictures.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => { itemsRef.current.forEach(it => it.preview && URL.revokeObjectURL(it.preview)); }, []);

  const picked = e => { const list = Array.from(e.target.files || []); e.target.value = ''; add(list); };

  if (state === 'checking') {
    return <main className="cap-page cap-center"><p className="cap-quiet">Checking the link…</p></main>;
  }

  // With nothing sent there is nothing else to show. Once photos have gone,
  // they stay listed under the message, so it is clear what made it.
  const expired = state === 'expired';
  if (expired && !items.length) {
    return (
      <main className="cap-page cap-center">
        <div className="cap-mark" aria-hidden="true">⏱</div>
        <h1 className="cap-title">Link expired</h1>
        <p className="cap-quiet">{error}</p>
      </main>
    );
  }

  const full = usesLeft === 0;
  const going = items.filter(it => SENDING.has(it.state)).length;
  const sent = items.filter(it => it.state === 'sent').length;
  const caseTitle = target ? target.title || (target.number ? 'Untitled case' : 'New case (draft)') : null;
  const caseSub = target ? target.number || (target.title ? 'Draft' : null) : null;

  return (
    <main className="cap-page">
      <header className="cap-head">
        <h1 className="cap-title">{expired ? 'Link expired' : 'Add receipts'}</h1>
        {target ? (
          <div className="cap-case">
            <div className="cap-case-label">Going into</div>
            <div className="cap-case-title">{caseTitle}</div>
            {caseSub && <div className={`cap-case-sub${target.number ? ' is-number' : ''}`}>{caseSub}</div>}
          </div>
        ) : !expired && <p className="cap-quiet">They go to your receipts, to be put in a case on your computer.</p>}
      </header>

      {!expired && (
        <div className="cap-actions">
          {/* Large targets: this is used one-handed, probably standing up. */}
          <button type="button" className="btn btn-primary cap-btn" disabled={full} onClick={() => cameraRef.current && cameraRef.current.click()}>
            Take photo
          </button>
          <button type="button" className="btn btn-outline cap-btn" disabled={full} onClick={() => pickRef.current && pickRef.current.click()}>
            Choose photos
          </button>
        </div>
      )}
      {/* capture= opens the rear camera rather than a file browser; without it
          the same input is the library, which Choose photos wants. */}
      <input ref={cameraRef} type="file" hidden tabIndex={-1} accept="image/*" capture="environment" onChange={picked} />
      <input ref={pickRef} type="file" hidden tabIndex={-1} accept={PHOTO_ACCEPT_ATTR} multiple onChange={picked} />

      {!expired && (full
        ? <p className="cap-note"><strong>This link is full.</strong> It has taken all {LINK_PHOTOS} photos it can. Show a new QR code on your computer to carry on.</p>
        : <p className="cap-note">
            Each photo goes straight in and is read for you. This link takes up to {LINK_PHOTOS} photos
            {usesLeft !== null && usesLeft < LINK_PHOTOS ? ` (${usesLeft} left)` : ''} and stays open for {LINK_MINUTES} minutes after the last one.
          </p>)}
      {error && <p className="cap-error" role="alert">{error}</p>}

      {items.length > 0 && (
        <section className="cap-sent" aria-label="Your photos">
          <div className="cap-sent-head" aria-live="polite">
            {going ? `Sending ${going === 1 ? 'a photo' : `${going} photos`}…` : `Sent (${sent})`}
          </div>
          <ul className="cap-rows">
            {items.map(it => <PhotoRow key={it.key} it={it} onRetry={() => retry(it.key)} />)}
          </ul>
          {sent > 0 && <p className="cap-quiet cap-foot">They are on your computer now, waiting to be checked.</p>}
        </section>
      )}
    </main>
  );
}

// One photo: its thumbnail, what has happened to it, and Try again when the
// signal dropped. Confirms the RECEIPT was read, not just that a file moved.
function PhotoRow({ it, onRetry }) {
  const [broken, setBroken] = useState(false);
  const name = `Photo ${it.n}`;
  const pct = Math.round((it.progress || 0) * 100);
  let tone = 'busy', title = name, words;
  if (it.state === 'waiting') { tone = 'idle'; words = 'Waiting to send'; }
  else if (it.state === 'preparing') words = 'Getting it ready…';
  else if (it.state === 'sending') words = `Sending… ${pct}%`;
  else if (it.state === 'sent' && !it.parsed) words = 'Sent. Reading it…';
  else if (it.state === 'sent' && it.unreadable) { tone = 'warn'; words = 'Saved, but not read. Type it in on your computer.'; }
  else if (it.state === 'sent') {
    tone = 'ok';
    title = it.merchant || 'Receipt';
    words = it.total != null ? `${it.currency ? `${it.currency} ` : ''}${it.total}` : 'Amount not read';
  } else if (it.state === 'duplicate') { tone = 'warn'; words = it.words; }
  else if (it.state === 'over') { tone = 'warn'; words = `Not sent: this link has taken all ${LINK_PHOTOS} photos.`; }
  else { tone = 'bad'; words = it.words || 'Not sent.'; }
  const mark = { ok: '✓', warn: '!', bad: '!', busy: '◍', idle: '○' }[tone];

  return (
    <li className={`cap-row is-${tone}`}>
      <div className="cap-thumb">
        {it.preview && !broken && <img src={it.preview} alt="" decoding="async" onError={() => setBroken(true)} />}
      </div>
      <div className="cap-row-main">
        <div className="cap-row-name"><span className="cap-row-mark" aria-hidden="true">{mark}</span> {title}</div>
        <div className="cap-row-words">{words}</div>
        {it.state === 'sending' && <div className="cap-row-bar"><ProgressBar value={pct} label={`Sending ${name}`} tone="info" /></div>}
      </div>
      {it.state === 'failed' && it.retry && (
        <button type="button" className="btn btn-outline btn-sm cap-retry" onClick={onRetry}>Try again</button>
      )}
    </li>
  );
}
