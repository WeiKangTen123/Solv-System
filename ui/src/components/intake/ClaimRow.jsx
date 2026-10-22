// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import { useVisiblePolling } from '../../utils/useVisiblePolling';
import { ProgressBar } from '../ui';

// A claim form (with its zips) handed to the claim import: one row for the
// whole import, following the job the way ClaimImport.jsx does (every 1.5 s,
// only while the tab is looked at, until it ends). The reconciliation, the
// Stop and the Undo stay in ClaimImport, which "Details" opens on this job.
//
// `onJob(job)` passes each answer up (the uploader keeps it on the row);
// `onDetails()` opens ClaimImport; `onDismiss()` takes an ended row away.
const POLL_MS = 1500;
const ENDED = ['done', 'failed', 'cancelled', 'gone'];
const STAGE = {
  queued: 'Waiting to start',
  unpacking: 'Unpacking the zip',
  unpacked: 'Reading the claim form',
  'reading form': 'Reading the claim form',
  'form read': 'Reading the receipts',
  'reading receipts': 'Reading the receipts',
  matching: 'Matching receipts to claim lines',
  categorising: 'Suggesting categories',
  saving: 'Saving the claims',
  cancelling: 'Stopping',
};

function words(job) {
  const stage = job && job.stage;
  if (stage === 'done') {
    const r = job.result || {};
    const n = r.inCase ?? (r.created ? r.created.length : 0);
    return `Imported: ${n} receipt${n === 1 ? '' : 's'} in this case`;
  }
  if (stage === 'failed') return job.error || 'The import failed.';
  if (stage === 'cancelled') return 'The import was stopped, and nothing from it was kept.';
  if (stage === 'gone') return 'This import is no longer on the server.';
  const read = job && job.receiptsTotal > 0 ? ` · ${job.receiptsRead} of ${job.receiptsTotal} read` : '';
  return `Claim import: ${STAGE[stage] || 'Working'}…${read}`;
}

export default function ClaimRow({ row, onJob, onDetails, onDismiss }) {
  const job = row.job || {};
  const ended = ENDED.includes(job.stage);

  useVisiblePolling(async () => {
    if (!row.jobId || ENDED.includes((row.job || {}).stage)) return;
    try { onJob(await api.get(`/claims/import/${row.jobId}`)); }
    catch (err) { if (err.status === 404) onJob({ ...row.job, stage: 'gone' }); }
  }, POLL_MS);

  const tone = !ended ? 'busy' : job.stage === 'done' ? 'ok' : 'bad';
  const mark = !ended ? '◍' : job.stage === 'done' ? '✓' : '!';
  return (
    <li className={`in-row is-${tone}`}>
      <span className="in-mark" aria-hidden="true">{mark}</span>
      <div className="in-row-main">
        <div className="in-row-name" title={row.name}>{row.name}</div>
        <div className="in-row-words">{words(job)}</div>
        {!ended && job.receiptsTotal > 0 && (
          <div className="in-row-progress">
            <ProgressBar value={job.receiptsRead} max={job.receiptsTotal} label={`Claim import of ${row.name}`}
                         valueText={`${job.receiptsRead} of ${job.receiptsTotal} read`} tone="info" />
          </div>
        )}
      </div>
      <div className="in-row-side">
        {job.stage !== 'gone' && <button type="button" className="btn btn-outline btn-sm" onClick={onDetails}>Details<span className="sr-only"> of the import of {row.name}</span></button>}
        {ended && job.stage !== 'done' && <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>Remove<span className="sr-only"> {row.name}</span></button>}
      </div>
    </li>
  );
}
