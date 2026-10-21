const db = require('../db');
const logger = require('../utils/logger');

// A draft is made the moment a first file is dropped on the New case page.
// One whose files never arrived (a closed tab, a failed upload, a person who
// changed their mind) is an empty case with no number that nobody will come
// back to, and it would sit in the Drafts tab for ever. Once a day, and once
// at boot, those are removed.
//
// Only empty ones. A draft with receipts in it is somebody's work, however
// old, and is never removed here. And only drafts nobody has touched for a
// day: the age is counted from the last change, so a draft whose cover is
// being typed before its files arrive is not taken from under its owner.
const DAY_MS = 24 * 60 * 60 * 1000;

function sweepDrafts({ olderThanMs = DAY_MS, now = Date.now() } = {}) {
  const cutoff = new Date(now - olderThanMs).toISOString();
  const removed = db.prepare(`DELETE FROM expense_reports
                              WHERE status = 'draft' AND MAX(created_at, COALESCE(updated_at, '')) < ?
                                AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.report_id = expense_reports.id)`).run(cutoff).changes;
  if (removed) logger.info('Removed empty drafts nobody came back to', { removed });
  return removed;
}

let timer = null;
// A sweep that fails is logged, and the next one tries again; it must not
// take the server down at boot.
function _run() {
  try { sweepDrafts(); }
  catch (err) { logger.warn('Sweeping empty drafts failed', { error: err.message }); }
}
function start() {
  if (timer) return;
  _run();
  timer = setInterval(_run, DAY_MS);
  // The process may exit with this pending: nothing is lost by not sweeping.
  if (timer.unref) timer.unref();
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { sweepDrafts, start, stop, DAY_MS };
