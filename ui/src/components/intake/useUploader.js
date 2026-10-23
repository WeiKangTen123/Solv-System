import { useEffect, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import { prepareReceipt, blobToBase64, postWithProgress, humanSize } from '../receipts/receipt-upload';
import { planDrop } from './intake-logic';

// The files this page is sending: any number at once, three on the wire at a
// time, each with a state of its own that the panel shows as a row.
//
//   queued       waiting for a free slot (or for the draft to exist)
//   preparing    a photo being shrunk to a JPEG in the browser
//   uploading    on its way; `progress` 0..1
//   stored       the server has it (`receiptId`); reading is the server's now
//   duplicate    the server already had it (`dupOf`, its receipt, if ours)
//   unsupported  not a receipt the server or this page can take (`message`)
//   too-big      over a limit (`message`)
//   failed       the network or the server failed (`retryable`), or the
//                server refused for a reason a retry will not fix
//   claim        handed to the claim import as one job (`jobId`, `job`)
//
//   skipped      what an email held besides its receipts, left out by the
//                server (`skipped`: [{ name, why }]); nothing to do about it
//
// A row is { id, kind: 'receipt' | 'zip' | 'mail' | 'claim', name, size,
// state, progress, message, note, receiptId, expenseIds, storedAt, dupOf,
// retryable, jobId, job, skipped }. The files themselves are held aside (not
// in React state) and let go once a file is stored or refused for good; a
// failed one keeps its file so Retry can send it again.
//
// `ensureCase()` is awaited before anything is sent and answers the case id:
// on the New case page that is the moment the draft is made. `onStored` is
// told each time a file lands, `onSettled` when nothing is left to send.
const SLOTS = 3;
const BUSY = new Set(['queued', 'preparing', 'uploading']);
let seq = 0;
const newId = () => `u${Date.now().toString(36)}${(seq++).toString(36)}`;
const base = name => String(name || '').split('/').pop();
const sentence = s => String(s || '').replace(/^./, c => c.toUpperCase());

function makeUploader(publishRows, cbs) {
  const s = { rows: [], payload: new Map(), aborts: new Map(), active: 0, pumping: false, gone: false };
  const publish = () => publishRows(s.rows);
  const alive = id => s.rows.some(r => r.id === id);
  const patch = (id, p) => {
    if (!alive(id)) return;
    s.rows = s.rows.map(r => (r.id === id ? { ...r, ...p } : r));
    publish();
  };
  const row = p => ({ id: newId(), kind: 'receipt', progress: 0, message: '', ...p });
  const busy = () => s.rows.filter(r => BUSY.has(r.state)).length;

  function add(files) {
    const plan = planDrop(files);
    const fresh = [];
    for (const f of plan.receipts) { const r = row({ name: f.name, size: f.size, state: 'queued' }); s.payload.set(r.id, f); fresh.push(r); }
    for (const f of plan.zips) { const r = row({ kind: 'zip', name: f.name, size: f.size, state: 'queued' }); s.payload.set(r.id, f); fresh.push(r); }
    for (const f of plan.mails) { const r = row({ kind: 'mail', name: f.name, size: f.size, state: 'queued' }); s.payload.set(r.id, f); fresh.push(r); }
    if (plan.claim) {
      const { archives, forms } = plan.claim;
      const others = archives.length ? ` and ${archives.length} zip${archives.length === 1 ? '' : 's'}` : '';
      const r = row({ kind: 'claim', name: `${forms[0].name}${others}`, size: [...archives, ...forms].reduce((n, f) => n + f.size, 0), state: 'queued' });
      s.payload.set(r.id, plan.claim);
      fresh.push(r);
    }
    for (const x of plan.refused) fresh.push(row({ name: x.file.name, size: x.file.size, state: x.state, message: x.why }));
    if (!fresh.length) return;
    s.rows = [...s.rows, ...fresh];
    publish();
    pump();
  }

  // Starts what fits in the free slots. One pump at a time: a slot freed
  // while this one waits for the case is picked up when its loop looks again.
  async function pump() {
    if (s.gone || s.pumping) return;
    s.pumping = true;
    try {
      while (!s.gone && s.active < SLOTS && s.rows.some(r => r.state === 'queued')) {
        let caseId = null, why = '';
        try { caseId = await cbs.current.ensureCase(); }
        catch (err) { why = err.message; }
        if (!caseId) {
          const message = `The draft could not be saved, so nothing was sent${why ? `: ${why}` : '.'}`;
          s.rows = s.rows.map(r => (r.state === 'queued' ? { ...r, state: 'failed', retryable: true, message } : r));
          publish();
          break;
        }
        const next = s.rows.find(r => r.state === 'queued');
        if (!next || s.gone) break;
        s.active++;
        patch(next.id, { state: next.kind === 'receipt' ? 'preparing' : 'uploading', progress: 0, message: '' });
        run(next, caseId).finally(() => {
          s.active--;
          pump();
          if (!busy()) cbs.current.onSettled?.();
        });
      }
    } finally { s.pumping = false; }
  }

  async function run(r, caseId) {
    const ctrl = new AbortController();
    s.aborts.set(r.id, ctrl);
    let shown = 0;
    // Every few percent is enough: each one redraws the list.
    const onProgress = p => {
      const pct = Math.round(p * 100);
      if (pct - shown < 4 && pct < 100) return;
      shown = pct;
      patch(r.id, { progress: p });
    };
    // null when the row was removed or stopped while it went.
    const send = (path, body) => postWithProgress(path, body, { signal: ctrl.signal, onProgress })
      .catch(err => (err.kind === 'aborted' ? null : { status: 0, body: { error: err.message } }));
    try {
      if (r.kind === 'receipt') await sendReceipt(r, caseId, send);
      else if (r.kind === 'zip') await sendZip(r, caseId, send);
      else if (r.kind === 'mail') await sendMail(r, caseId, send);
      else await sendClaim(r, caseId, send);
    } catch (err) {
      // Ours, not the server's: the file could not be read from the disk.
      patch(r.id, { state: 'failed', retryable: true, message: err.message || 'The file could not be read. Try again.' });
    } finally {
      s.aborts.delete(r.id);
    }
  }

  function stored(id, body) {
    patch(id, { state: 'stored', receiptId: body.receipt.id, expenseIds: body.expense ? [body.expense.id] : [], storedAt: Date.now(), progress: 1, message: body.note || '' });
    s.payload.delete(id);
    cbs.current.onStored?.();
  }

  // What the server's refusal means for the row.
  function refused(id, kind, { status, body }) {
    const message = (body && body.error) || (status ? `The server answered ${status}.` : 'The upload failed. Try again.');
    let p;
    if (kind === 'receipt' && status === 409 && (body.receiptId || 'duplicateOf' in body || /already uploaded/i.test(message))) p = { state: 'duplicate', dupOf: body.receiptId || null };
    else if (status === 400) p = { state: 'unsupported' };
    else if (status === 413) p = { state: 'too-big' };
    else {
      // A 401 is a session that ended; asking through the client signs out
      // the way every other page does.
      if (status === 401) api.get('/auth/me').catch(() => {});
      p = { state: 'failed', retryable: status === 0 || status === 401 || status === 429 || status >= 500 };
    }
    if (!p.retryable) s.payload.delete(id);
    patch(id, { ...p, message, progress: 0 });
  }

  async function sendReceipt(r, caseId, send) {
    const file = s.payload.get(r.id);
    let prep;
    try { prep = await prepareReceipt(file); }
    catch (err) {
      s.payload.delete(r.id);
      patch(r.id, { state: err.kind === 'too-big' ? 'too-big' : 'unsupported', message: err.message });
      return;
    }
    if (!alive(r.id) || s.gone) return;
    // Worth saying: a 9 MB photo going up as 700 KB is why it was quick.
    const note = prep.bytes < prep.originalBytes ? `${humanSize(prep.originalBytes)} → ${humanSize(prep.bytes)}` : '';
    patch(r.id, { state: 'uploading', progress: 0, note });
    const data = await blobToBase64(prep.blob);
    const res = await send('/receipts', { mime: prep.mime, data, filename: file.name, source: 'upload', reportId: caseId, ...(prep.convertedFrom ? { convertedFrom: prep.convertedFrom } : {}) });
    if (!res) return;
    if (res.status === 201) stored(r.id, res.body);
    else refused(r.id, 'receipt', res);
  }

  // A zip is unpacked into the case by the server; its row gives way to one
  // row per file in it, stored or skipped with why.
  async function sendZip(r, caseId, send) {
    const file = s.payload.get(r.id);
    const data = await blobToBase64(file);
    const res = await send('/receipts/archive', { data, filename: file.name, reportId: caseId });
    if (!res) return;
    if (res.status === 409 && res.body.claimForm) {
      // A claim form inside: it is a claim, and the claim import reads it.
      s.payload.set(r.id, { archives: [file], forms: [] });
      patch(r.id, { kind: 'claim', state: 'queued', progress: 0 });
      return;
    }
    if (res.status !== 200 && res.status !== 201) { refused(r.id, 'zip', res); return; }
    const at = Date.now();
    const rows = [
      ...(res.body.stored || []).map(x => row({ name: x.receipt.originalName || file.name, size: x.receipt.sizeBytes, state: 'stored', receiptId: x.receipt.id, expenseIds: x.expense ? [x.expense.id] : [], storedAt: at, progress: 1, message: x.note || '' })),
      ...(res.body.skipped || []).map(x => row({ name: `${file.name} › ${base(x.name)}`, state: /already uploaded/i.test(x.why) ? 'duplicate' : 'unsupported', message: sentence(x.why) })),
    ];
    if (!rows.length) rows.push(row({ kind: 'zip', name: file.name, size: file.size, state: 'unsupported', message: 'There were no receipts in this zip.' }));
    s.payload.delete(r.id);
    s.rows = s.rows.flatMap(x => (x.id === r.id ? rows : [x]));
    publish();
    if (res.body.stored && res.body.stored.length) cbs.current.onStored?.();
  }

  // An email is opened by the server: each receipt attached to it is stored
  // as if dropped by itself, and a mail with none is kept as a PDF of the
  // message (an e-receipt). Its row gives way to one row per receipt stored,
  // like a zip's; an attachment already in the case is a duplicate row, and
  // what was left out (a logo, a signature) is one quiet row that lists each
  // with why. A file that is not an email comes back a 400 with the
  // server's reason, said on the row.
  async function sendMail(r, caseId, send) {
    const file = s.payload.get(r.id);
    const data = await blobToBase64(file);
    const res = await send('/receipts/email', { data, filename: file.name, reportId: caseId });
    if (!res) return;
    if (res.status !== 200 && res.status !== 201) { refused(r.id, 'mail', res); return; }
    const at = Date.now();
    const stored = res.body.stored || [];
    const skipped = res.body.skipped || [];
    const dupes = skipped.filter(x => /already uploaded/i.test(x.why || ''));
    const left = skipped.filter(x => !dupes.includes(x));
    const rows = [
      ...stored.map(x => row({ name: x.receipt.originalName || file.name, size: x.receipt.sizeBytes, state: 'stored', receiptId: x.receipt.id, expenseIds: x.expense ? [x.expense.id] : [], storedAt: at, progress: 1, message: x.note || '' })),
      ...dupes.map(x => row({ name: `${file.name} › ${base(x.name)}`, state: 'duplicate', message: sentence(x.why) })),
    ];
    if (left.length) {
      // Nothing kept at all is the person's to know about; a logo left out
      // beside the receipt that was kept is not.
      const none = !stored.length && !dupes.length;
      const one = left.length === 1 ? left[0] : null;
      const message = none
        ? (one ? `Nothing in this email could be kept as a receipt: ${one.why}.` : 'Nothing in this email could be kept as a receipt.')
        : (one ? `Left out ${base(one.name)}: ${one.why}.` : `${left.length} parts of it were left out.`);
      rows.push(row({
        kind: 'mail', name: file.name, size: file.size, state: none ? 'unsupported' : 'skipped', message,
        // Listed one by one only when there are several: one is said in full.
        skipped: one ? null : left.map(x => ({ name: base(x.name), why: x.why })),
      }));
    }
    if (!rows.length) rows.push(row({ kind: 'mail', name: file.name, size: file.size, state: 'unsupported', message: 'Nothing in this email could be kept as a receipt.' }));
    s.payload.delete(r.id);
    s.rows = s.rows.flatMap(x => (x.id === r.id ? rows : [x]));
    publish();
    if (stored.length) cbs.current.onStored?.();
  }

  // A claim form and its zips go to the claim import as one job; its row
  // then follows the job (ClaimRow polls it).
  async function sendClaim(r, caseId, send) {
    const { archives, forms } = s.payload.get(r.id);
    const encode = list => Promise.all(list.map(async f => ({ name: f.name, data: (await blobToBase64(f)).split(',')[1] || '' })));
    const label = (forms[0] || archives[0] || {}).name || 'Expense claim';
    const res = await send('/claims/import', { archives: await encode(archives), forms: await encode(forms), label, reportId: caseId });
    if (!res) return;
    if (res.status !== 202 && res.status !== 200) { refused(r.id, 'claim', res); return; }
    s.payload.delete(r.id);
    patch(r.id, { state: 'claim', progress: 1, jobId: res.body.jobId, job: { id: res.body.jobId, stage: res.body.stage, receiptsRead: 0, receiptsTotal: 0 } });
  }

  function retry(id) {
    const r = s.rows.find(x => x.id === id);
    if (!r || r.state !== 'failed' || !s.payload.has(id)) return;
    patch(id, { state: 'queued', message: '', progress: 0 });
    pump();
  }

  // Takes a row off the page; one still going is stopped first.
  function remove(id) {
    s.aborts.get(id)?.abort();
    s.payload.delete(id);
    s.rows = s.rows.filter(r => r.id !== id);
    publish();
  }

  // Everything still to send or on its way is stopped and dropped: the case
  // it was going to is being thrown away.
  function stop() {
    for (const ctrl of s.aborts.values()) ctrl.abort();
    for (const r of s.rows) if (BUSY.has(r.state)) s.payload.delete(r.id);
    s.rows = s.rows.filter(r => !BUSY.has(r.state));
    publish();
  }

  return {
    add, retry, remove, stop, busy,
    setJob: (id, job) => patch(id, { job }),
    // On screen again (React's development mode mounts twice): pick up where
    // it was. Gone for good: whatever is on its way stops, as the page warned.
    attach() { s.gone = false; pump(); },
    detach() { s.gone = true; for (const ctrl of s.aborts.values()) ctrl.abort(); },
  };
}

export function useUploader({ ensureCase, onStored, onSettled }) {
  const [rows, setRows] = useState([]);
  const cbs = useRef(null);
  cbs.current = { ensureCase, onStored, onSettled };
  const ctl = useRef(null);
  if (!ctl.current) ctl.current = makeUploader(setRows, cbs);
  const up = ctl.current;
  useEffect(() => { up.attach(); return () => up.detach(); }, [up]);
  return { rows, ...up };
}
