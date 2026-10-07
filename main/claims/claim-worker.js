const claimQueue      = require('./claim-queue');
const logger          = require('../utils/logger');

const POLL_MS = 5000;

// Per-user worker state
const _workers = new Map();

// One import runs at a time across the whole server. Each user's queue was
// already one-at-a-time, but ten people importing at once was ten archives of
// up to 150 MB unpacked in memory together. The next one starts when the slot
// frees; nobody's import is refused, only queued.
const MAX_RUNNING = 1;
let _running = 0;

function _getWorker(userId) {
  if (!_workers.has(userId)) {
    _workers.set(userId, { deps: null, pollId: null, running: false, busy: false });
  }
  return _workers.get(userId);
}

// ── Job types ───────────────────────────────────────────────────────────────
// The worker runs whatever is registered here, keyed by job.type. Each type
// supplies `run({ userId, job, payload, deps })`, which must eventually call
// deps.onSettle, and `defaultDeps(userId)` for when the caller passes none.
// Claim import is the first type; bill and invoice import register their own
// from their own modules, so this file does not have to know about them.
const _types = new Map();
function registerJobType(type, { run, defaultDeps = () => ({}) } = {}) {
  if (typeof run !== 'function') throw new Error(`Job type "${type}" needs a run function`);
  _types.set(type, { run, defaultDeps });
}
function _handlerFor(job) {
  // Jobs written before types existed are all claim imports.
  return _types.get(job.type || 'claim-import') || null;
}

// claim-import registers itself (see routes/claims.js) so this runner has no
// reason to load the reader, the store or the model at boot.

// `jobs` is the queue as the poll just read it, when it has; otherwise it is read here.
async function _processNext(userId, jobs = null) {
  const w = _getWorker(userId);
  if (!w.running || w.busy) return;
  const queued = jobs || claimQueue.list(userId);

  // 1. Poison check: if an interrupted job exceeded max attempts, fail it so it cannot loop
  const poisoned = claimQueue.getPoisoned(userId, queued);
  for (const p of poisoned) {
    logger.error(`[claim-worker:${userId}] Job ${p.id} poison threshold reached (${p.attempts} attempts) — setting aside`, { jobId: p.id });
    claimQueue.markFailed(userId, p.id, 'Import failed repeatedly and was stopped to protect system stability');
  }

  // 2. Fetch pending jobs
  const pending = claimQueue.getPending(userId, queued);
  if (!pending.length) return;
  if (_running >= MAX_RUNNING) return;     // the poll comes back for it

  w.busy = true;
  _running++;
  let released = false;
  const release = () => { if (!released) { released = true; _running = Math.max(0, _running - 1); } };
  const job = pending[0];

  try {
    logger.info(`[claim-worker:${userId}] Starting job ${job.id} (attempt ${job.attempts + 1})`, { jobId: job.id, label: job.label });
    const handler = _handlerFor(job);
    if (!handler) {
      // Set aside with a reason rather than retried three times into poison.
      claimQueue.markFailed(userId, job.id, `No handler is registered for job type "${job.type}"`);
      w.busy = false;
      release();
      if (claimQueue.getPending(userId).length > 0) setImmediate(() => _safeProcessNext(userId));
      return;
    }
    // The job as written, kept so each progress write need not read it back.
    let onDisk = claimQueue.markRunning(userId, job.id);
    // Read payload buffers back from disk
    const payload = claimQueue.readPayload(userId, job);
    const baseDeps = w.deps || handler.defaultDeps(userId);

    const deps = {
      ...baseDeps,
      onUpdate: (patch) => {
        try {
          onDisk = claimQueue.save(userId, patch, onDisk) || onDisk;
        } catch (err) {
          logger.warn(`[claim-worker:${userId}] Could not persist progress patch`, { jobId: job.id, error: err.message });
        }
      },
      onSettle: (settledJob) => {
        try {
          claimQueue.save(userId, {
            id: settledJob.id,
            stage: settledJob.stage,
            error: settledJob.error,
            result: settledJob.result,
            receiptsTotal: settledJob.receiptsTotal,
            receiptsRead: settledJob.receiptsRead,
            rowsTotal: settledJob.rowsTotal,
          }, onDisk);
        } catch (err) {
          logger.warn(`[claim-worker:${userId}] Could not persist final settled state`, { jobId: job.id, error: err.message });
        } finally {
          w.busy = false;
          release();
          const remaining = claimQueue.getPending(userId);
          if (remaining.length > 0) setImmediate(() => _safeProcessNext(userId));
        }
      },
    };

    handler.run({ userId, job, payload, deps });
  } catch (err) {
    logger.error(`[claim-worker:${userId}] Job ${job.id} failed to launch`, { error: err.message });
    claimQueue.markFailed(userId, job.id, err.message);
    w.busy = false;
    release();
    const remaining = claimQueue.getPending(userId);
    if (remaining.length > 0) setImmediate(() => _safeProcessNext(userId));
  }
}

function _safeProcessNext(userId, jobs) {
  _processNext(userId, jobs).catch(err => {
    logger.error(`[claim-worker:${userId}] Unexpected worker error`, { error: err.message });
  });
}

// Start worker for a user
function startWorker(userId, customDeps = null) {
  const w = _getWorker(userId);
  if (customDeps) w.deps = customDeps;
  if (w.running) return;
  w.running = true;
  logger.info(`[claim-worker:${userId}] Worker started`);

  setImmediate(() => _safeProcessNext(userId));

  w.pollId = setInterval(() => {
    // One read of the queue a tick, shared by everything below.
    const jobs = claimQueue.list(userId);
    // Nothing waiting and nothing running: stop. A new import starts the
    // worker again. It used to poll the disk every five seconds for ever
    // after a person's first import.
    if (!w.busy && !claimQueue.getPending(userId, jobs).length) { stopWorker(userId); return; }
    _safeProcessNext(userId, jobs);
  }, POLL_MS);
  if (typeof w.pollId.unref === 'function') w.pollId.unref();
}

// Stop worker for a user
function stopWorker(userId) {
  const w = _workers.get(userId);
  if (!w) return;
  if (w.pollId) clearInterval(w.pollId);
  w.running = false;
  w.pollId  = null;
  _workers.delete(userId);
}

// Trigger immediate check
function kickWorker(userId) {
  setImmediate(() => _safeProcessNext(userId));
}

// Finished jobs past their hour are swept on a timer of their own. The sweep
// used to run on a person's worker, which stops once nothing is waiting, so a
// finished import stayed on disk until that person imported again or the
// server restarted.
const SWEEP_MS = 10 * 60 * 1000;
let _sweeper = null;
function _sweepAll() {
  for (const userId of claimQueue.getAllUserIds()) {
    try { claimQueue.sweep(userId); }
    catch (err) { logger.warn(`[claim-worker:${userId}] Sweep failed`, { error: err.message }); }
  }
}
function startSweeper() {
  if (_sweeper) return;
  _sweeper = setInterval(_sweepAll, SWEEP_MS);
  if (typeof _sweeper.unref === 'function') _sweeper.unref();
}

// Recover pending jobs across all users on server boot, and start the sweep.
async function recoverPendingJobs(makeDeps = null) {
  startSweeper();
  const userIds = claimQueue.getAllUserIds();
  for (const userId of userIds) {
    claimQueue.sweep(userId);
    const pending = claimQueue.getPending(userId);
    if (!pending.length) continue;
    logger.info(`[claim-worker] Recovering ${pending.length} pending claim job(s)`, { userId });
    const deps = makeDeps ? await makeDeps(userId) : null;
    startWorker(userId, deps);
  }
}

function _reset() {
  for (const w of _workers.values()) {
    if (w.pollId) clearInterval(w.pollId);
  }
  _workers.clear();
  _types.clear();
  if (_sweeper) { clearInterval(_sweeper); _sweeper = null; }
  _running = 0;
}

module.exports = {
  registerJobType,
  startWorker,
  stopWorker,
  kickWorker,
  recoverPendingJobs,
  startSweeper,
  _processNext,
  _safeProcessNext,
  _reset,
};
