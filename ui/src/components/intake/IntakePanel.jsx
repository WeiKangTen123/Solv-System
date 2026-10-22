import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { useViewMode } from '../../context/ViewModeContext';
import { DropZone, ProgressBar, useWindowDrop } from '../ui';
import { ACCEPT_ATTR } from '../receipts/receipt-upload';
import PhonePairingModal from '../receipts/PhonePairingModal';
import ClaimImport from '../receipts/ClaimImport';
import FileRow from './FileRow';
import ClaimRow from './ClaimRow';
import { useUploader } from './useUploader';
import { useIntake } from './useIntake';
import { bucketOf, countRows, countsLine, fmtEta, mergeRows, pollEvery, waitingRetry } from './intake-logic';

// Receipts going into a case: the drop zone and its buttons, then one row per
// file with how far it has got, from the moment it is picked to the moment
// the AI has read it. The New case page shows it in full beside the case's
// details; the case page embeds it `compact`, as a slim drop line whose list
// shows only the files still on their way or needing the person (the case
// page lists the receipts already read itself).
//
// Files can be dropped anywhere on the page, not only on the zone (pageDrop).
// Uploads go three at a time (useUploader); the server's side is polled
// (useIntake) every 2 s while anything is on its way or being read.
//
// Props:
//   caseId      the case the files go into; null on the New case page until
//               the first file makes the draft.
//   ensureCase  async () => caseId: awaited before anything is sent, so the
//               New case page can make its draft then. Leave it out when
//               caseId is fixed.
//   compact     the case page's slim version.
//   onChange    fn({ intake, at, uploading, error }) whenever the server's
//               answer or the number of files still uploading changes. The
//               page owns the leave guard (useLeaveGuard; one per page) and
//               reads `uploading` for it.
//   pageDrop    take files dropped anywhere on the page (default true).
//
// A ref gets { add(files), stop(), uploading(), refresh(), choose(), phone() }:
// files handed over from elsewhere, stopping every upload (a discarded draft),
// the count still on its way right now, a fresh poll, the file picker, and the
// phone code (Home's "Use my phone" lands on New case with it open).
const IntakePanel = forwardRef(function IntakePanel({ caseId, ensureCase, compact = false, onChange, pageDrop = true }, ref) {
  const { user } = useAuth();
  const base = (user && user.baseCurrency) || 'SGD';
  const { isMobile } = useViewMode();
  const confirm = useConfirm();
  const zoneRef = useRef(null);
  const cameraRef = useRef(null);
  const pickRef = useRef(null);
  const [pairing, setPairing] = useState(null);     // the case a phone is sending to
  const [details, setDetails] = useState(null);     // a claim import's job id
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(() => new Set());
  const [, tick] = useState(0);

  const caseRef = useRef(caseId);
  caseRef.current = caseId;
  const ensure = useCallback(async () => (ensureCase ? ensureCase() : caseRef.current), [ensureCase]);

  const intakeRef = useRef(null);
  const up = useUploader({ ensureCase: ensure, onSettled: () => intakeRef.current && intakeRef.current.refresh() });
  const intake = useIntake(caseId, () => pollEvery({ uploading: up.busy(), files: (intakeRef.current && intakeRef.current.data && intakeRef.current.data.files) || [] }, Date.now()));
  intakeRef.current = intake;

  const now = Date.now();
  const rows = useMemo(() => mergeRows(up.rows, intake.data && intake.data.files, { polledAt: intake.at }), [up.rows, intake.data, intake.at]);
  const counts = countRows(rows, now);
  const uploading = up.rows.filter(r => ['queued', 'preparing', 'uploading'].includes(r.state)).length;
  const waiting = rows.some(r => r.file && waitingRetry(r.file.read, now));

  // A countdown on screen ("trying again in 0:40") moves every second.
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  useEffect(() => {
    changeRef.current && changeRef.current({ intake: intake.data, at: intake.at, uploading, error: intake.error });
  }, [intake.data, intake.at, intake.error, uploading]);

  // Through a ref, so the handle does not change on every render while
  // still calling the phone() of the latest one.
  const phoneRef = useRef(null);
  useImperativeHandle(ref, () => ({
    add: up.add, stop: up.stop, uploading: up.busy, refresh: intake.refresh,
    choose: () => (isMobile ? pickRef.current && pickRef.current.click() : zoneRef.current && zoneRef.current.open()),
    phone: () => phoneRef.current && phoneRef.current(),
  }), [up.add, up.stop, up.busy, intake.refresh, isMobile]);

  const drop = useWindowDrop(files => up.add(files), { enabled: pageDrop && !pairing && !details, label: 'Drop to add them to this case' });

  const nameOf = useCallback(receiptId => {
    const f = ((intake.data && intake.data.files) || []).find(x => x.receiptId === receiptId);
    return f ? f.originalName || 'a receipt' : null;
  }, [intake.data]);

  // One request for a row's button, with the row's buttons off meanwhile.
  async function busyWith(key, fn) {
    setWorking(w => new Set(w).add(key));
    setNotice('');
    try { await fn(); }
    catch (err) { setNotice(err.message || 'That did not work. Try again.'); }
    finally {
      setWorking(w => { const n = new Set(w); n.delete(key); return n; });
      intake.refresh();
    }
  }

  async function act(what, row) {
    const { local, file } = row;
    if (what === 'retry') { up.retry(local.id); return; }
    if (what === 'dismiss' || what === 'cancel') { up.remove(local.id); return; }
    const receiptId = file ? file.receiptId : local && local.receiptId;
    if (what === 'tryNow') { await busyWith(row.key, () => api.post(`/receipts/${receiptId}/read/retry`, {})); return; }
    if (what === 'typeIt') { await busyWith(row.key, () => api.delete(`/receipts/${receiptId}/read`)); return; }
    if (what !== 'remove') return;
    const ids = file ? (file.expenses || []).map(e => e.id) : (local.expenseIds || []);
    const name = (local && local.name) || (file && file.originalName) || 'this file';
    const ok = await confirm({
      title: `Remove ${name}?`,
      message: ids.length > 1 ? `The ${ids.length} receipts read from it are deleted as well.` : 'Its receipt is deleted, from this case and from your receipts.',
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    await busyWith(row.key, async () => {
      for (const id of ids) {
        // Already gone (removed in another tab) is what was wanted.
        try { await api.delete(`/expenses/${id}`); } catch (err) { if (err.status !== 404) throw err; }
      }
      if (local) up.remove(local.id);
    });
  }

  async function phone() {
    setNotice('');
    try {
      const id = await ensure();
      if (!id) throw new Error('there is no case to send to');
      setPairing(id);
    } catch (err) { setNotice(`The phone link could not be made: ${err.message}`); }
  }
  phoneRef.current = phone;

  const shown = compact ? rows.filter(r => (r.local && r.local.kind === 'claim') || bucketOf(r, now) !== 'read') : rows;
  const settled = counts.read + counts.needYou;
  const going = counts.uploading + counts.reading + counts.waiting;
  const tone = going ? 'info' : counts.needYou ? 'warning' : 'success';
  const eta = counts.reading + counts.waiting ? fmtEta(intake.data && intake.data.etaSeconds) : '';
  const leave = counts.uploading
    ? 'Keep this page open until the uploads finish.'
    : counts.reading || counts.waiting ? 'You can leave this page: reading carries on without it.' : '';
  const pickFiles = e => { up.add(Array.from(e.target.files || [])); e.target.value = ''; };

  return (
    <section className={`in-panel${compact ? ' is-compact' : ''}`} aria-label="Receipts">
      {drop.overlay}

      <div className="in-drop">
        {!isMobile && (
          <DropZone ref={zoneRef} onFiles={up.add} accept={ACCEPT_ATTR} compact={compact}
                    label={compact ? 'Drop more receipts here, or click to choose' : 'Drop receipts here'}>
            Photos, HEIC, PDF, a zip of receipts, or a claim form
          </DropZone>
        )}
        <div className="in-drop-actions">
          {isMobile ? (
            <>
              <button type="button" className="btn btn-primary" onClick={() => cameraRef.current && cameraRef.current.click()}>Take photo</button>
              <button type="button" className="btn btn-outline" onClick={() => pickRef.current && pickRef.current.click()}>Choose photos</button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => zoneRef.current && zoneRef.current.open()}>Choose files</button>
              <button type="button" className="btn btn-outline btn-sm" onClick={phone} title="Scan a code to photograph receipts with your phone">Phone QR</button>
            </>
          )}
        </div>
        {/* One photo straight from the camera; several from the library. */}
        <input ref={cameraRef} type="file" hidden tabIndex={-1} accept="image/*" capture="environment" onChange={pickFiles} />
        <input ref={pickRef} type="file" hidden tabIndex={-1} accept={ACCEPT_ATTR} multiple onChange={pickFiles} />
      </div>

      {notice && <div className="alert alert-error in-notice" role="alert"><span className="alert-icon">✕</span>{notice}</div>}
      {intake.error && intake.error.status === 404 && <div className="alert alert-error in-notice" role="alert"><span className="alert-icon">✕</span>This case is no longer there.</div>}

      {counts.files > 0 && (!compact || going || counts.needYou > 0) && (
        <div className="in-status">
          <div className="in-status-line" aria-live="polite">{countsLine(counts)}</div>
          <ProgressBar value={settled} max={counts.files} label="Files read" valueText={`${settled} of ${counts.files} done`} tone={tone} />
          {(eta || leave) && <div className="in-status-sub">{[eta && `${eta[0].toUpperCase()}${eta.slice(1)}.`, leave].filter(Boolean).join(' ')}</div>}
        </div>
      )}

      {shown.length > 0 && (
        <ul className="in-rows" aria-label="Files">
          {shown.map(r => (r.local && r.local.kind === 'claim' && r.local.state === 'claim'
            ? <ClaimRow key={r.key} row={r.local}
                        onJob={job => { up.setJob(r.local.id, job); if (job.stage === 'done') intake.refresh(); }}
                        onDetails={() => setDetails(r.local.jobId)} onDismiss={() => up.remove(r.local.id)} />
            : <FileRow key={r.key} row={r} now={now} base={base} nameOf={nameOf} act={act} working={working.has(r.key)} />))}
        </ul>
      )}

      {pairing && (
        <PhonePairingModal reportId={pairing} onArrived={() => intake.refresh()}
                           onClose={() => { setPairing(null); intake.refresh(); }} />
      )}
      {details && (
        <ClaimImport initialJobId={details} reportId={caseId} onClose={() => setDetails(null)} onImported={() => intake.refresh()} />
      )}
    </section>
  );
});

export default IntakePanel;
