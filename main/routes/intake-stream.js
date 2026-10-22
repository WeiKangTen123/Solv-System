const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { canView } = require('../middleware/roles');
const reports = require('../store/reports');
const events  = require('../utils/events');
const { intakeView } = require('../reports/intake-view');
const logger  = require('../utils/logger');

// GET /api/reports/:id/intake/stream — the case's intake (the same body as
// GET /:id/intake), sent as a server-sent event at once and again whenever
// the case changes, for as long as the page is open.
//
// The New case page used to ask every two seconds while anything was being
// read: fifty receipts were minutes of requests, each one loading the case,
// and most of them answered "nothing new". Now the read queue says when a
// read moves on (utils/events.js), and the page hears about it within a
// fraction of a second.
//
// Not everything that changes a case goes through the queue: a receipt
// checked on the review page, a file removed, a cover saved in another tab.
// So the intake is also worked out every few seconds, and sent only when it
// differs from what this page was last sent.
//
// Mounted at /api/reports ahead of the reports router (index.js), and left
// out of the global rate limit (middleware/rate-limit-key.js) like the poll it
// replaces.

const cfg = {
  // Changes come in bursts (a read starts, lands, refreshes the cover); one
  // event for the lot.
  gatherMs: 300,
  // How often a change made outside the queue is looked for.
  checkMs: 5_000,
  // A comment line this often, so nginx, which gives up on a silent upstream
  // after 180 s, never takes a quiet case for a dead connection.
  keepAliveMs: 25_000,
  // Closed after this; the page opens a new one. A stream is never held for
  // a whole day by a tab left open, and a role taken away meanwhile is
  // asked again within the quarter-hour.
  lifeMs: 15 * 60_000,
};

// The company's currency and day, for the flags, from GET /:id/intake's own
// function (routes/reports.js): the two must send the same body, and a copy
// here would drift from it.
const _flagOptions = companyId => require('./reports').flagOptions(companyId);

// The case as this person may see it, or null: gone (a discarded draft, a
// case merged away) or not theirs to see.
function _visible(id, user) {
  const r = reports.getReport(id);
  return r && canView(user, r.userId, r.companyId) ? r : null;
}

router.get('/:id/intake/stream', requireAuth, (req, res) => {
  const id = req.params.id;
  if (!_visible(id, req.user)) return res.status(404).json({ error: 'Case not found' });

  // no-transform keeps compression from holding the events back (as for the
  // assistant's streamed answer), and X-Accel-Buffering tells nginx to pass
  // each one straight through.
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });

  let last = '';
  let gather = null;
  let closed = false;
  const open = () => !closed && !res.writableEnded && !res.destroyed;
  const write = text => { if (open()) res.write(text); };

  // `reason` says why the stream ended, so the page can tell the planned
  // end, which it answers by opening a new one at once, from a fault.
  function finish(reason) {
    if (closed) return;
    write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
    cleanUp();
    if (!res.writableEnded) res.end();
  }

  function send() {
    if (!open()) return;
    let body;
    try {
      const r = _visible(id, req.user);
      if (!r) return finish('gone');
      body = JSON.stringify(intakeView(r, _flagOptions(r.companyId)));
    } catch (err) {
      // The next change or check tries again; the page keeps what it has.
      logger.warn('Case intake not worked out for its stream', { reportId: id, error: err.message });
      return;
    }
    if (body === last) return;
    last = body;
    write(`event: intake\ndata: ${body}\n\n`);
  }

  const off = events.onCase(id, () => {
    if (gather) return;
    gather = setTimeout(() => { gather = null; send(); }, cfg.gatherMs);
  });
  const check = setInterval(send, cfg.checkMs);
  const keepAlive = setInterval(() => write(': keep-alive\n\n'), cfg.keepAliveMs);
  const life = setTimeout(() => finish('time'), cfg.lifeMs);

  function cleanUp() {
    if (closed) return;
    closed = true;
    off();
    clearTimeout(gather);
    clearInterval(check);
    clearInterval(keepAlive);
    clearTimeout(life);
  }
  // The tab closed, the page moved on, or the connection dropped.
  res.on('close', cleanUp);

  send();
});

// Tests: shorter waits of their own.
function _configure(opts = {}) { Object.assign(cfg, opts); }

module.exports = router;
module.exports._configure = _configure;
