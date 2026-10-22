const { EventEmitter } = require('events');
const logger = require('./logger');

// Something about a case changed, for whoever is watching it now: the New case
// page and the case page hold a stream open (routes/intake-stream.js) and send
// the case's intake again when they hear of it, instead of asking every two
// seconds whether anything happened.
//
// In the process, not in the database: one server process runs (see
// ecosystem.config.js), and a watcher that misses an event because it was
// not connected yet loses nothing, since every stream starts with the whole
// intake and checks again on a timer of its own.

const bus = new EventEmitter();
// One listener per open page on a case: the owner's tabs, an admin looking.
// Fifty on one case is a leak, not a busy afternoon, and Node says so.
bus.setMaxListeners(50);

const _name = reportId => `case:${reportId}`;

function caseChanged(reportId) {
  if (!reportId) return;
  bus.emit(_name(reportId), reportId);
}

// Calls fn(reportId) on every change to that case until the returned off() is
// called. A listener that throws is logged and does not stop the others, nor
// whatever made the change.
function onCase(reportId, fn) {
  const name = _name(reportId);
  const listener = id => {
    try { fn(id); }
    catch (err) { logger.warn('A case watcher failed', { reportId: id, error: err.message }); }
  };
  bus.on(name, listener);
  let on = true;
  return () => {
    if (!on) return;
    on = false;
    bus.removeListener(name, listener);
  };
}

// A receipt's read moved on (queued, started, done, failed, stopped): every
// case its rows are filed in hears of it. Nobody watching, no query.
function receiptChanged(receiptId) {
  if (!receiptId || !bus.eventNames().length) return [];
  const ids = require('../db').prepare('SELECT DISTINCT report_id AS id FROM expenses WHERE receipt_id = ? AND report_id IS NOT NULL')
    .all(receiptId).map(r => r.id);
  for (const id of ids) caseChanged(id);
  return ids;
}

const listenerCount = reportId => bus.listenerCount(_name(reportId));

module.exports = { caseChanged, onCase, receiptChanged, listenerCount };
