const db = require('../db');
const { newId } = require('../utils/ids');
const { HttpError } = require('../utils/http-error');
const logger = require('../utils/logger');

// Every receipt read goes through here, one job per stored file (read_jobs).
//
// A read used to start in the upload's own process the moment the file was
// stored. Fifty receipts dropped at once were fifty reads at once, one
// person's batch held everyone else's single photo behind it, a restart lost
// whatever was under way, and a busy AI service failed the receipt with
// "press Re-read in a few minutes", leaving the person to do the waiting.
//
// Now a job is a row before anything starts, so a restart finds it again. A
// few are read at once (READ_CONCURRENCY), no more than two of one person's
// (READ_PER_USER), and the next one is the oldest of whoever has the fewest
// running, so a single photo goes ahead of somebody's fiftieth. A read that
// found every key busy is tried again by itself after 1, 5, 15 and 60
// minutes, with the rows left 'reading', and only then released with the
// reader's note; any other failure is tried once more after 30 seconds.
//
// One process reads: the worker lives in the server, as the reads did.

const BUSY_DELAYS_MIN = [1, 5, 15, 60];
const ERROR_DELAY_MS = 30 * 1000;
// However the failures fall, a job is never tried more often than this.
const MAX_ATTEMPTS = BUSY_DELAYS_MIN.length + 2;
// A retry an hour away is woken by a timer; it sleeps at most a minute at a
// time, so a clock that jumps cannot strand it.
const MAX_SLEEP_MS = 60 * 1000;

const FAILED_NOTE  = 'The receipt could not be read. Press Re-read, or type the fields from the receipt.';
const STOPPED_NOTE = 'Reading was stopped. Type the fields from the receipt, or press Re-read.';
const BUSY_ERROR   = 'The AI service was busy.';

const _count = (name, fallback) => {
  const n = Math.floor(Number(process.env[name]));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};
const cfg = {
  concurrency: _count('READ_CONCURRENCY', 4),
  perUser: _count('READ_PER_USER', 2),
  now: () => Date.now(),
  read: _readFromDisk,
};

let _stopped = false;
let _timer = null;      // the wake for the next job waiting on a retry
let _soon = null;       // a wake already asked for
let _onDone = null;
const _active = new Map();   // job id -> { userId, promise }

const _iso = ms => new Date(ms).toISOString();
function _job(row) {
  if (!row) return null;
  return {
    id: row.id, companyId: row.company_id, userId: row.user_id, receiptId: row.receipt_id, expenseId: row.expense_id,
    state: row.state, attempts: row.attempts, nextAt: row.next_at, errorKind: row.error_kind, error: row.error,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
  };
}
const _get = id => _job(db.prepare('SELECT * FROM read_jobs WHERE id = ?').get(id));
const _latest = receiptId => db.prepare('SELECT * FROM read_jobs WHERE receipt_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(receiptId);

// Queues a read of one stored receipt. A receipt already waiting or being
// read keeps the job it has.
function enqueue({ companyId, userId, receiptId, expenseId = null }) {
  const live = db.prepare("SELECT * FROM read_jobs WHERE receipt_id = ? AND state IN ('queued', 'reading') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(receiptId);
  if (live) return _job(live);
  const id = newId();
  const at = _iso(cfg.now());
  db.prepare(`INSERT INTO read_jobs (id, company_id, user_id, receipt_id, expense_id, state, attempts, next_at, created_at)
              VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`).run(id, companyId, userId, receiptId, expenseId || null, at, at);
  _wake();
  return _get(id);
}

// Off the caller's path: the upload answers before its read starts.
function _wake() {
  if (_stopped || _soon) return;
  _soon = setImmediate(() => { _soon = null; _tick(); });
  _soon.unref();
}

// Each person's oldest job that is due; whoever has the fewest running goes
// next, and between equals whoever has waited longest.
function _pick() {
  const at = _iso(cfg.now());
  const running = new Map();
  for (const a of _active.values()) running.set(a.userId, (running.get(a.userId) || 0) + 1);
  const heads = db.prepare(`SELECT user_id, MIN(created_at) AS first FROM read_jobs
                            WHERE state = 'queued' AND next_at <= ? GROUP BY user_id ORDER BY first`).all(at);
  let best = null;
  for (const h of heads) {
    const n = running.get(h.user_id) || 0;
    if (n >= cfg.perUser) continue;
    if (!best || n < best.n) best = { userId: h.user_id, n };
  }
  if (!best) return null;
  return db.prepare("SELECT * FROM read_jobs WHERE state = 'queued' AND next_at <= ? AND user_id = ? ORDER BY created_at, rowid LIMIT 1").get(at, best.userId);
}

// Starts as many due jobs as there is room for. Returns their promises, which
// settle once each job has been written back (tests await them).
function _tick() {
  if (_stopped) return [];
  const started = [];
  while (_active.size < cfg.concurrency) {
    const row = _pick();
    if (!row) break;
    const p = _run(row);
    if (p) started.push(p);
  }
  _arm();
  return started;
}

function _run(row) {
  const claimed = db.prepare("UPDATE read_jobs SET state = 'reading', attempts = attempts + 1, started_at = ? WHERE id = ? AND state = 'queued'")
    .run(_iso(cfg.now()), row.id);
  if (!claimed.changes) return null;
  const job = _get(row.id);
  const promise = (async () => {
    let outcome;
    try { outcome = await cfg.read(job, { deferIfUnavailable: true }); }
    catch (err) { outcome = { error: err }; }
    try { _settle(job, row.error_kind, outcome); }
    catch (err) { logger.error('A read job could not be written back', { jobId: job.id, error: err.message }); }
  })().finally(() => { _active.delete(job.id); _wake(); });
  _active.set(job.id, { userId: job.userId, promise });
  return promise;
}

// What one attempt came to. Every write is conditional on the job still being
// 'reading': one cancelled, or deleted with its receipt, meanwhile stays so.
function _settle(job, priorKind, outcome) {
  const now = cfg.now();
  if (outcome && outcome.unavailable) {
    if (job.attempts <= BUSY_DELAYS_MIN.length) return _retry(job, now + BUSY_DELAYS_MIN[job.attempts - 1] * 60 * 1000, 'unavailable', BUSY_ERROR);
    return _fail(job, 'unavailable', BUSY_ERROR, require('./read-receipt').UNAVAILABLE_NOTE);
  }
  if (outcome && outcome.error) {
    const err = outcome.error;
    logger.warn('Receipt read failed', { jobId: job.id, receiptId: job.receiptId, attempt: job.attempts, error: err && err.message });
    // What the owner is shown: our own sentences, never a stack's.
    const said = err && err.said ? err.message : 'Something went wrong while reading it.';
    if (priorKind !== 'error' && job.attempts < MAX_ATTEMPTS) return _retry(job, now + ERROR_DELAY_MS, 'error', said);
    return _fail(job, 'error', said, FAILED_NOTE);
  }
  const done = db.prepare("UPDATE read_jobs SET state = 'done', finished_at = ?, error_kind = NULL, error = NULL WHERE id = ? AND state = 'reading'")
    .run(_iso(now), job.id);
  if (done.changes) _ended(job.id);
}
function _retry(job, at, kind, error) {
  db.prepare("UPDATE read_jobs SET state = 'queued', next_at = ?, error_kind = ?, error = ? WHERE id = ? AND state = 'reading'")
    .run(_iso(at), kind, error, job.id);
}
function _fail(job, kind, error, note) {
  const failed = db.prepare("UPDATE read_jobs SET state = 'failed', finished_at = ?, error_kind = ?, error = ? WHERE id = ? AND state = 'reading'")
    .run(_iso(cfg.now()), kind, error, job.id);
  if (!failed.changes) return;
  _release(job.receiptId, note);
  _ended(job.id);
}

// The read is over without one: every row of the file still 'reading' is
// handed to its owner with the note, and the receipt is stamped so the phone
// can tell "finished" from "still reading".
function _release(receiptId, note) {
  const store = require('../store/expenses');
  for (const e of store.expensesForReceipt(receiptId)) {
    if (e.status !== 'reading') continue;
    store.updateExpense(e.id, { status: 'review-needed', errorMsg: [e.errorMsg, note].filter(Boolean).join(' ') });
  }
  const r = store.getReceipt(receiptId);
  if (r && !r.parsedAt) store.updateReceipt(receiptId, { parsedAt: _iso(cfg.now()) });
}

function _ended(id) {
  if (!_onDone) return;
  const job = _get(id);
  try {
    const out = _onDone(job);
    if (out && typeof out.catch === 'function') out.catch(err => logger.warn('The step after a read failed', { jobId: id, error: err.message }));
  } catch (err) {
    logger.warn('The step after a read failed', { jobId: id, error: err.message });
  }
}

// Sleeps until the next retry is due. A job due now but held back by the
// limits starts when a running one finishes, which wakes the worker anyway.
function _arm() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_stopped) return;
  const row = db.prepare("SELECT MIN(next_at) AS at FROM read_jobs WHERE state = 'queued' AND next_at > ?").get(_iso(cfg.now()));
  if (!row || !row.at) return;
  const wait = Math.min(Math.max(Date.parse(row.at) - cfg.now(), 0), MAX_SLEEP_MS);
  _timer = setTimeout(() => { _timer = null; _tick(); }, wait + 50);
  _timer.unref();
}

const _dueCount = () => db.prepare("SELECT COUNT(*) AS n FROM read_jobs WHERE state = 'queued' AND next_at <= ?").get(_iso(cfg.now())).n;

function start() { _stopped = false; _tick(); }

// Takes no more jobs. Those running finish; drain() waits for them.
function stop() {
  _stopped = true;
  if (_timer) clearTimeout(_timer);
  if (_soon) clearImmediate(_soon);
  _timer = null; _soon = null;
}

// Resolves once nothing is being read and, unless stopped, nothing due is
// waiting — or once `ms` has passed. True when it got there in time.
async function drain(ms = Infinity) {
  const until = Date.now() + ms;
  const left = () => until - Date.now();
  for (;;) {
    if (left() <= 0) return false;
    if (_soon) { await new Promise(resolve => setImmediate(resolve)); continue; }
    if (_active.size) { await _within([..._active.values()].map(a => a.promise), left()); continue; }
    if (!_stopped && _dueCount()) { _tick(); if (_active.size) continue; }
    return true;
  }
}
function _within(promises, ms) {
  if (!Number.isFinite(ms)) return Promise.allSettled(promises);
  let t;
  const timeout = new Promise(resolve => { t = setTimeout(resolve, ms); t.unref(); });
  return Promise.race([Promise.allSettled(promises), timeout]).finally(() => clearTimeout(t));
}

// Jobs a restart caught mid-read go back to the queue. The attempt they were
// on is not counted: the AI was never the problem.
function recover() {
  const mine = JSON.stringify([..._active.keys()]);
  const n = db.prepare(`UPDATE read_jobs SET state = 'queued', attempts = MAX(attempts - 1, 0), next_at = ?, started_at = NULL
                        WHERE state = 'reading' AND id NOT IN (SELECT value FROM json_each(?))`).run(_iso(cfg.now()), mine).changes;
  if (n) logger.info('Reads a restart interrupted are queued again', { jobs: n });
  return n;
}

// The latest job of each receipt, for the pages that show progress.
function statesFor(receiptIds) {
  const out = new Map();
  const ids = [...new Set((receiptIds || []).filter(Boolean))];
  if (!ids.length) return out;
  const rows = db.prepare('SELECT * FROM read_jobs WHERE receipt_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid').all(JSON.stringify(ids));
  for (const r of rows) out.set(r.receipt_id, { state: r.state, attempts: r.attempts, nextAt: r.next_at, errorKind: r.error_kind, error: r.error });
  return out;
}

// A row the person has not touched since the read failed: still to be
// checked, never read, and nothing typed in. Only these go back to 'reading',
// where the reader's answer would land on them.
const _untouched = e => e.status === 'review-needed' && !e.aiReadAt && !e.merchant && !e.total && !e.claimed;
function _withoutReadNotes(msg) {
  let s = String(msg || '');
  for (const note of [require('./read-receipt').UNAVAILABLE_NOTE, FAILED_NOTE]) s = s.split(note).join(' ');
  return s.replace(/\s+/g, ' ').trim() || null;
}

// "Try now": a job waiting for its retry is read at once, and a failed one is
// queued again from the start. Throws a 409 HttpError saying why when there is
// nothing to try.
function retryNow(receiptId) {
  const row = _latest(receiptId);
  if (!row) throw new HttpError(409, 'This receipt has no read to try again. Use Re-read on it.');
  const at = _iso(cfg.now());
  if (row.state === 'queued') {
    db.prepare("UPDATE read_jobs SET next_at = ? WHERE id = ? AND state = 'queued'").run(at, row.id);
  } else if (row.state === 'failed') {
    const store = require('../store/expenses');
    const rows = store.expensesForReceipt(receiptId).filter(_untouched);
    if (!rows.length) throw new HttpError(409, 'This receipt has been changed since its read failed. Use Re-read on it.');
    db.transaction(() => {
      for (const e of rows) store.updateExpense(e.id, { status: 'reading', errorMsg: _withoutReadNotes(e.errorMsg) });
      store.updateReceipt(receiptId, { parsedAt: null });
      db.prepare(`UPDATE read_jobs SET state = 'queued', attempts = 0, next_at = ?, error_kind = NULL, error = NULL, started_at = NULL, finished_at = NULL
                  WHERE id = ?`).run(at, row.id);
    })();
  } else if (row.state === 'reading') {
    throw new HttpError(409, 'This receipt is being read now.');
  } else {
    throw new HttpError(409, 'This receipt is no longer waiting to be read. Use Re-read on it.');
  }
  _wake();
  return _get(row.id);
}

// "Stop": a job still waiting is dropped and its rows handed to the person
// with a note. One already being read is not stopped half-way.
function cancel(receiptId) {
  const row = _latest(receiptId);
  if (row && row.state === 'reading') throw new HttpError(409, 'This receipt is being read now, and will be done in a moment.');
  if (!row || row.state !== 'queued') throw new HttpError(409, 'Nothing is waiting to be read for this receipt.');
  db.prepare("UPDATE read_jobs SET state = 'cancelled', finished_at = ? WHERE id = ? AND state = 'queued'").run(_iso(cfg.now()), row.id);
  _release(receiptId, STOPPED_NOTE);
  return _get(row.id);
}

// Called with the job after it ends, done or failed (a case's cover is
// refreshed from it).
function setOnDone(fn) { _onDone = typeof fn === 'function' ? fn : null; }

// The read itself: the stored file, read onto its rows. Errors carry `said`
// when their message is for the person.
async function _readFromDisk(job, opts) {
  const store = require('../store/expenses');
  const said = message => Object.assign(new Error(message), { said: true });
  const receipt = store.getReceipt(job.receiptId);
  if (!receipt) throw said('The receipt is no longer there.');
  const buffer = require('./receipt-store').forUser(receipt.userId).read(receipt.file);
  if (!buffer) throw said('The receipt file is missing.');
  const first = (job.expenseId && store.getExpense(job.expenseId)) || store.expensesForReceipt(receipt.id)[0];
  if (!first) throw said('The receipt has no expense to read into.');
  return require('./read-receipt').readReceipt({
    companyId: job.companyId, userId: job.userId, receiptId: receipt.id, expenseId: first.id,
    buffer, mime: receipt.mime, source: receipt.source || 'upload',
  }, opts);
}

// Tests: a clock, a reader and the limits of their own.
function _configure(opts = {}) { Object.assign(cfg, opts); }

module.exports = {
  enqueue, start, stop, drain, statesFor, retryNow, cancel, setOnDone, recover, _tick, _configure,
  BUSY_DELAYS_MIN, ERROR_DELAY_MS, FAILED_NOTE, STOPPED_NOTE,
};
