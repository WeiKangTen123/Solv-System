import { useEffect, useRef, useState } from 'react';
import { blobToBase64 } from './receipt-upload';
import Modal from '../Modal';
import { useConfirm } from '../../context/ConfirmContext';
// api/client prepends BASE = '/api', so paths here start after it.
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useVisiblePolling } from '../../utils/useVisiblePolling';

// Importing a batch expense claim: a zip of receipts plus the claim form.
//
// The import is a background job, so this uploads, then polls. Closing the panel
// does not stop it — which is the point, since a large claim takes minutes.

const POLL_MS = 1500;
// .xlsx only. The server reads the claim form with a library that opens .xlsx
// (a zip of XML) and not the older binary .xls, which was offered here and then
// failed as "not a readable spreadsheet".
const ACCEPT = '.zip,.xlsx,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TERMINAL = ['done', 'failed', 'cancelled'];

const STAGES = [
  ['unpacking',        'Unpacking archives'],
  ['reading form',     'Reading the claim form'],
  ['reading receipts', 'Reading receipts'],
  ['matching',         'Matching receipts to claim lines'],
  ['categorising',     'Suggesting categories'],
  ['saving',           'Saving claims'],
];
const stageIndex = stage => {
  const i = STAGES.findIndex(([k]) => k === stage);
  if (i >= 0) return i;
  return ['unpacked', 'form read'].includes(stage) ? 1 : (stage === 'done' ? STAGES.length : -1);
};

// The bare base64 of a file, through the one reader the upload uses.
const fileToBase64 = file => blobToBase64(file).then(uri => uri.split(',')[1]).catch(() => { throw new Error(`${file.name} could not be read`); });

// `reportId` is the case the panel was opened from, if any: the receipts go
// into it rather than into a new case.
export default function ClaimImport({ onClose, onImported, initialJobId = null, reportId = null }) {
  const confirm = useConfirm();
  const fileRef = useRef(null);
  const [files, setFiles]   = useState([]);
  const [job, setJob]       = useState(initialJobId ? { id: initialJobId, stage: 'reading receipts' } : null);
  const [error, setError]   = useState('');
  const [starting, setStart] = useState(false);
  // Stop was pressed: the panel waits for the import to say how it ended,
  // rather than announcing an outcome it does not know yet.
  const [stopping, setStopping] = useState(false);
  // The person's last finished import, offered when nothing is running. A
  // finished import is not "active", so closing the panel used to lose its
  // reconciliation and its Undo for good; the server keeps it for an hour.
  const [latest, setLatest] = useState(null);

  useEffect(() => {
    if (initialJobId) {
      api.get(`/claims/import/${initialJobId}`)
        .then(res => setJob(res))
        .catch(err => setError(err.message || 'Could not load import job'));
    }
  }, [initialJobId]);

  useEffect(() => {
    if (initialJobId) return undefined;
    let alive = true;
    api.get('/claims/latest')
      .then(d => { if (alive) setLatest((d && d.job) || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [initialJobId]);

  const archives = files.filter(f => /\.zip$/i.test(f.name));
  const forms    = files.filter(f => /\.xlsx$/i.test(f.name));
  // Only those two extensions are sent. Anything else used to sit in the list
  // looking attached and then go nowhere — the request carried neither, and the
  // server answered "attach at least a claim archive or a claim form" while the
  // file was plainly on screen. It is now marked, and an empty file is marked
  // too, since that fails on the server rather than here.
  const unsupported = files.filter(f => !/\.(zip|xlsx)$/i.test(f.name));
  const oldExcel    = unsupported.some(f => /\.xls$/i.test(f.name));
  const emptyFiles  = files.filter(f => f.size === 0);
  const sendable    = archives.length + forms.length;

  // Polls while the job runs, and only while the tab is being looked at. A
  // stopped import is polled too, until it says how it ended. An answer for a
  // job no longer on screen is dropped.
  useVisiblePolling(async () => {
    if (!job?.id || TERMINAL.includes(job.stage)) return;
    const next = await api.get(`/claims/import/${job.id}`);
    setJob(cur => (cur && cur.id === next.id ? next : cur));
    if (next.stage === 'done') onImported?.();
  }, POLL_MS);

  async function start() {
    setStart(true); setError('');
    try {
      const encode = async list => Promise.all(list.map(async f => ({ name: f.name, data: await fileToBase64(f) })));
      const res = await api.post('/claims/import', {
        archives: await encode(archives),
        forms:    await encode(forms),
        label:    forms[0]?.name || archives[0]?.name || 'Expense claim',
        ...(reportId ? { reportId } : {}),
      });
      setJob({ id: res.jobId, stage: res.stage, receiptsRead: 0, receiptsTotal: 0 });
    } catch (err) {
      setError(err.message || 'Could not start the import');
    } finally { setStart(false); }
  }

  async function stop() {
    setStopping(true); setError('');
    try {
      const res = await api.delete(`/claims/import/${job.id}`);
      setJob(cur => (cur ? { ...cur, stage: res.stage } : cur));
    } catch (err) {
      setStopping(false);
      setError(err.message || 'Could not stop the import');
    }
  }

  function startAgain() {
    setJob(null); setFiles([]); setStopping(false); setError(''); setLatest(null);
  }

  // 'cancelled' used to fall through every branch below, leaving an empty box
  // with no way back to the file picker.
  const done      = job?.stage === 'done';
  const failed    = job?.stage === 'failed';
  const cancelled = job?.stage === 'cancelled';
  const active    = job && !TERMINAL.includes(job.stage);
  const s = job?.result?.summary;

  return (
    // Only the moment of sending holds the panel open. A running import keeps
    // going on the server and is found again when the panel reopens, as the
    // panel itself says; holding it open for minutes said the opposite.
    <Modal onClose={onClose} busy={starting} maxWidth={560} card label="Import an expense claim">

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Import an expense claim</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>
              A zip of receipts and the claim form, as they arrive by email.
            </div>
          </div>
          <button onClick={onClose} disabled={starting} aria-label="Close"
                  style={{ background: 'none', border: 'none', cursor: starting ? 'not-allowed' : 'pointer',
                           color: 'var(--text-muted)', fontSize: 22, lineHeight: 1, opacity: starting ? 0.4 : 1 }}>×</button>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}><span className="alert-icon">✕</span>{error}</div>}

        {/* ── Pick the files ────────────────────────────────────────────── */}
        {!job && (
          <>
            {latest && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
                            background: 'var(--bg-secondary)', borderRadius: 10, padding: '10px 12px', marginBottom: 14, fontSize: 12 }}>
                <span>Your last import, {latest.label}, has finished.</span>
                <button className="btn btn-outline btn-sm" onClick={() => setJob(latest)}>See the result</button>
              </div>
            )}

            <input ref={fileRef} type="file" accept={ACCEPT} multiple style={{ display: 'none' }}
                   onChange={e => setFiles(Array.from(e.target.files || []))} />
            <div onClick={() => fileRef.current?.click()} role="button" tabIndex={0} aria-label="Choose the claim files"
                 onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
                 style={{ border: '1px dashed var(--border)', borderRadius: 12, padding: '26px 18px',
                          textAlign: 'center', cursor: 'pointer', marginBottom: 14 }}>
              <div style={{ fontSize: 22, opacity: 0.5 }}>🗂</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>Choose the claim files</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                One or more .zip archives, plus the .xlsx claim form
              </div>
            </div>

            {files.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                {files.map((f, i) => {
                  const bad = !/\.(zip|xlsx)$/i.test(f.name) || f.size === 0;
                  return (
                    <div key={`${i}:${f.name}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, padding: '6px 0', borderTop: '1px solid var(--border)', opacity: bad ? 0.6 : 1 }}>
                      <span style={{ color: bad ? 'var(--danger)' : undefined }}>
                        {bad ? '⚠' : /\.zip$/i.test(f.name) ? '🗜' : '📊'} {f.name}
                      </span>
                      <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {f.size === 0 ? 'empty' : `${Math.round(f.size / 1024)} KB`}
                      </span>
                    </div>
                  );
                })}
                {/* Reading receipts costs a model call each, so the size of the
                    job is stated before anyone commits to it. */}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                  {archives.length} archive{archives.length === 1 ? '' : 's'} · {forms.length} form{forms.length === 1 ? '' : 's'}.
                  Every receipt is read by AI, which takes a few seconds each — a large claim can take a couple of minutes.
                </div>

                {/* Said here rather than after a failed round trip: these are the
                    two reasons a file on this list would not have been sent. */}
                {(unsupported.length > 0 || emptyFiles.length > 0) && (
                  <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 8, lineHeight: 1.5 }}>
                    {unsupported.length > 0 && (
                      <div>
                        ⚠ {unsupported.map(f => f.name).join(', ')} will not be sent — only .zip archives and .xlsx claim forms are read.
                        {oldExcel && ' An .xls form can be opened in Excel and saved as .xlsx.'}
                      </div>
                    )}
                    {emptyFiles.length > 0 && (
                      <div>⚠ {emptyFiles.map(f => f.name).join(', ')} is empty. If it lives in iCloud Drive or a network folder, open it once so it downloads.</div>
                    )}
                  </div>
                )}
              </div>
            )}

            <button className="btn btn-primary" style={{ width: '100%' }}
                    disabled={!sendable || starting} onClick={start}>
              {starting ? <><span className="btn-spinner" /> Starting…</>
                : sendable ? 'Import claim' : 'Attach a .zip or .xlsx to continue'}
            </button>
          </>
        )}

        {/* ── Progress ──────────────────────────────────────────────────── */}
        {active && (
          <div>
            {STAGES.map(([key, label], i) => {
              const at = stageIndex(job.stage);
              const state = i < at ? 'done' : i === at ? 'now' : 'todo';
              const isReading = key === 'reading receipts' && state !== 'todo';
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', fontSize: 12.5,
                                        color: state === 'todo' ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                  <span style={{ width: 14, color: state === 'done' ? 'var(--success)' : 'var(--accent)' }}>
                    {state === 'done' ? '✓' : state === 'now' ? '◍' : '·'}
                  </span>
                  <span style={{ flex: 1 }}>{label}</span>
                  {isReading && job.receiptsTotal > 0 && (
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                      {job.receiptsRead} / {job.receiptsTotal}
                    </span>
                  )}
                </div>
              );
            })}

            {job.receiptsTotal > 0 && (
              <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-hover)', overflow: 'hidden', margin: '12px 0 8px' }}>
                <div style={{ height: '100%', background: 'var(--accent)', borderRadius: 2, transition: 'width .3s ease',
                              width: `${Math.round((job.receiptsRead / job.receiptsTotal) * 100)}%` }} />
              </div>
            )}

            {stopping || job.stage === 'cancelling' ? (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Stopping. Anything this import has already saved is being taken back.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  This keeps running if you close it — the expenses appear in My expenses when it finishes.
                </div>
                <button className="btn btn-outline btn-sm" style={{ marginTop: 12 }} onClick={stop}>
                  Stop
                </button>
              </>
            )}
          </div>
        )}

        {failed && (
          <>
            <div className="alert alert-error"><span className="alert-icon">✕</span>{job.error || 'The import failed.'}</div>
            <button className="btn btn-outline" style={{ marginTop: 12 }} onClick={startAgain}>Start again</button>
          </>
        )}

        {/* Nothing read is kept unless it was saved, and a stopped import takes
            back what it saved: this used to say that everything already read
            was in My expenses. */}
        {cancelled && (
          <>
            <div className="alert alert-info" style={{ marginBottom: 0 }}>
              The import was stopped, and nothing from it was kept.
            </div>
            <button className="btn btn-outline" style={{ marginTop: 12 }} onClick={startAgain}>Import a claim</button>
          </>
        )}

        {/* ── Reconciliation ────────────────────────────────────────────── */}
        {done && s && (() => {
          const totalClaims = s.total || job.result?.created?.length || 0;
          const dupCount = (job.result?.duplicates?.length || 0) + (job.result?.suspectedDuplicates?.length || 0);
          // What is in the case, which is not every receipt made: a duplicate
          // stays out of it. Older results did not say, so it is worked out.
          const inCase = job.result?.inCase ?? Math.max(0, totalClaims - (job.result?.duplicates?.length || 0));
          const notRead = [
            ...(job.result?.formErrors || []).map(msg => {
              const at = msg.indexOf(': ');
              return at > 0 ? { name: msg.slice(0, at), why: msg.slice(at + 2) } : { name: 'Claim form', why: msg };
            }),
            ...(job.result?.skipped || []).map(x => ({ name: x.archive && x.archive !== x.name ? `${x.archive} › ${x.name}` : x.name, why: x.reason })),
          ];
          return (
            <div>
              {stopping && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
                  It had finished before it could be stopped, so everything below was kept. Undo import removes it.
                </div>
              )}

              {/* Everything that arrived together is already in one case, so the
                  first thing offered is the way into it. */}
              {job.result?.caseId && inCase > 0 && (
                <div style={{ background: 'var(--accent-subtle)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 14,
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {inCase} receipt{inCase === 1 ? ' is' : 's are'} {job.result.caseIsNew === false ? 'in the case you imported into' : 'in a new case'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Check them there, then submit the case.</div>
                  </div>
                  <Link className="btn btn-primary btn-sm" to={`/reports/${job.result.caseId}`} onClick={onClose}>Open the case</Link>
                </div>
              )}

              {/* "27 imported" is useless. What matters is which ones need a person. */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
                {[
                  { n: s.verified, label: 'matched and verified', tone: 'var(--success)' },
                  { n: dupCount, label: 'duplicates detected', tone: 'var(--danger)' },
                  { n: s.discrepancies, label: "amount doesn't match", tone: 'var(--danger)' },
                  { n: s.missingReceipts, label: 'no receipt found', tone: 'var(--warning)' },
                  { n: s.extraReceipts, label: job.rowsTotal > 0 ? 'receipt with no claim line' : 'receipts ready for review', tone: job.rowsTotal > 0 ? 'var(--warning)' : 'var(--success)' },
                  { n: s.unreadable, label: 'could not be read', tone: 'var(--text-muted)' },
                ].filter(x => x.n > 0).map(x => (
                  <div key={x.label} style={{ flex: '1 1 150px', background: 'var(--bg-secondary)', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: x.tone, fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>{x.n}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>{x.label}</div>
                  </div>
                ))}
              </div>

              {/* A form that could not be read, or a file in an archive that was
                  passed over, used to vanish without a word. */}
              {notRead.length > 0 && (
                <Section title="Files that were not read">
                  {notRead.map((x, i) => (
                    <div key={`${i}:${x.name}`} style={{ fontSize: 12, padding: '6px 0', borderTop: '1px solid var(--border)', lineHeight: 1.5 }}>
                      <span>{x.name}</span>
                      <span style={{ color: 'var(--warning)' }}> — {x.why}</span>
                    </div>
                  ))}
                </Section>
              )}

              {/* Keys carry the place in the list: two forms both have a row 1,
                  and the parts of one PDF share a file name. */}
              {dupCount > 0 && (
                <Section title="Duplicate receipts detected">
                  {[...(job.result.duplicates || []), ...(job.result.suspectedDuplicates || [])].map((d, i) => (
                    <Line key={`${i}:${d.id || ''}`}
                          left={`Receipt #${String(d.id || '').slice(-6)} · ${d.why || 'Matches existing receipt'}`}
                          right={d.of ? `duplicate of #${String(d.of).slice(-6)}` : 'duplicate'}
                          tone="var(--danger)" />
                  ))}
                </Section>
              )}

              {job.result.discrepancies?.length > 0 && (
                <Section title="Amounts that don't match the receipt">
                  {job.result.discrepancies.map((d, i) => (
                    <Line key={`${i}:${d.rowNo}`}
                          left={`Row ${d.rowNo} · ${d.description || ''}`}
                          right={`claimed ${d.claimed} · receipt ${d.onReceipt}`}
                          tone="var(--danger)" />
                  ))}
                </Section>
              )}

              {job.result.missingReceipts?.length > 0 && (
                <Section title="Claim lines with no receipt">
                  {job.result.missingReceipts.map((m, i) => (
                    <Line key={`${i}:${m.rowNo}`} left={`Row ${m.rowNo} · ${m.description || ''}`} right={String(m.amount ?? '')} tone="var(--warning)" />
                  ))}
                </Section>
              )}

              {job.result.extraReceipts?.length > 0 && job.rowsTotal > 0 && (
                <Section title="Receipts with no claim line">
                  {job.result.extraReceipts.map((r, i) => (
                    <Line key={`${i}:${r.file}`} left={r.file.split('/').pop()} right={`${r.merchant || '—'} ${r.total ?? ''}`} tone="var(--warning)" />
                  ))}
                </Section>
              )}

              {job.result.categoriesSuggested > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '10px 0', lineHeight: 1.5 }}>
                  {job.result.categoriesSuggested} categor{job.result.categoriesSuggested === 1 ? 'y was' : 'ies were'} suggested
                  for lines the claimant left blank — marked as suggestions, not answers.
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                {/* It closes the panel and nothing more; "Open N claims" said otherwise. */}
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={onClose}>
                  Done
                </button>
                {/* An import that went wrong should not need twenty-seven deletions. */}
                <button className="btn btn-outline"
                        onClick={async () => {
                          if (!(await confirm({ title: `Remove all ${totalClaims} claims?`, message: 'They are removed from this import together with their receipt files.', confirmLabel: 'Remove all', danger: true }))) return;
                          try { await api.delete(`/claims/group/${job.result.groupId}`); onImported?.(); onClose(); }
                          catch (err) { setError(err.message); }
                        }}>
                  Undo import
                </button>
              </div>
            </div>
          );
        })()}
    </Modal>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
                    color: 'var(--text-muted)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Line({ left, right, tone }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12,
                  padding: '6px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{left}</span>
      <span style={{ color: tone, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>{right}</span>
    </div>
  );
}
