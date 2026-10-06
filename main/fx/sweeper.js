const db = require('../db');
const logger = require('../utils/logger');
const { applyFx } = require('./apply');
const { isLocked } = require('../reports/workflow');
const store = require('../store/expenses');

// Rates are fetched the moment an expense needs one. When both providers are
// unreachable at that moment — a network blip, a provider outage, a laptop that
// uploaded on a train — the line is left without a rate, and until now the only
// way to price it was for somebody to notice and click Refresh rate. A claim
// could sit unsubmittable for days because of thirty seconds of bad network.
//
// This sweeps those lines. It is deliberately dull: a small batch, a quarter of
// an hour apart, oldest first, and it never touches an expense whose report has
// been submitted or a line somebody typed a rate onto.
const EVERY_MS = 15 * 60 * 1000;
const BATCH = 25;

let timer = null;
let running = false;

// Expenses carrying at least one line with no rate. A foreign line without a
// rate is the whole point; a base-currency line always has 1.
// Only what a sweep could actually fix. Without the last two conditions the
// oldest twenty-five expenses that can never be priced — one whose rate was
// refused and is waiting for a person, one sitting in a claimed case — held
// the batch for ever, and the twenty-sixth, which the provider would have
// priced instantly, was never reached on any sweep.
//
// A case is 'open' or 'claimed', nothing else (reports/workflow.js). This
// used to ask for 'draft' or 'rejected', the names from before cases, and
// since every receipt now lives in a case from the moment it lands, the query
// matched nothing at all: the sweeper ran every quarter of an hour and never
// priced a line.
//
// And a line that was tried and still has no rate waits an hour before it
// is tried again, least recently tried first: a currency no provider prices,
// or a monthly table nobody has filled in, used to keep the oldest lines in
// every batch, so the newer ones behind them were never reached.
const RETRY_AFTER_MS = 60 * 60 * 1000;
function pendingExpenseIds(limit = BATCH, now = Date.now()) {
  const cutoff = new Date(now - RETRY_AFTER_MS).toISOString();
  return db.prepare(`SELECT e.id FROM expenses e
                     JOIN expense_lines l ON l.expense_id = e.id
                     LEFT JOIN expense_reports r ON r.id = e.report_id
                     WHERE l.fx_rate IS NULL
                       AND l.fx_override_by IS NULL
                       AND l.fx_check IS NULL
                       AND (l.fx_tried_at IS NULL OR l.fx_tried_at < ?)
                       AND e.status NOT IN ('duplicate', 'rejected')
                       AND (e.report_id IS NULL OR r.status = 'open')
                     GROUP BY e.id
                     ORDER BY MAX(COALESCE(l.fx_tried_at, '')), e.created_at LIMIT ?`).all(cutoff, limit).map(r => r.id);
}
const _tried = { run: (at, id) => db.prepare('UPDATE expense_lines SET fx_tried_at = ? WHERE expense_id = ? AND fx_rate IS NULL').run(at, id) };

async function sweep() {
  if (running) return { skipped: 'already running' };
  running = true;
  const out = { looked: 0, priced: 0, stillPending: 0, locked: 0 };
  try {
    for (const id of pendingExpenseIds()) {
      const e = store.getExpense(id);
      if (!e) continue;
      out.looked++;
      if (isLocked(e)) { out.locked++; continue; }
      try {
        const r = await applyFx(id);
        if (r.applied) out.priced++;
        if (r.pending) { out.stillPending++; _tried.run(new Date().toISOString(), id); }
      } catch (err) {
        _tried.run(new Date().toISOString(), id);
        logger.warn('Sweeping a pending rate failed', { expenseId: id, error: err.message });
      }
    }
    if (out.priced) logger.info('Priced expenses that were waiting for a rate', out);
  } finally {
    running = false;
  }
  return out;
}

function start({ everyMs = EVERY_MS } = {}) {
  if (timer) return timer;
  timer = setInterval(() => { sweep().catch(err => logger.warn('Rate sweep failed', { error: err.message })); }, everyMs);
  // Never the reason a process stays alive.
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('Exchange-rate sweeper started', { everyMinutes: Math.round(everyMs / 60000) });
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { sweep, start, stop, pendingExpenseIds, EVERY_MS, BATCH };
