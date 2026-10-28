const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { canView } = require('../middleware/roles');
const reports = require('../store/reports');
const { caseActivity, MAX_LIMIT } = require('../reports/activity');

// GET /api/reports/:id/activity — the case's Activity tab: its own history
// and its receipts' changes, newest first (reports/activity.js). Seen by
// whoever may see the case: its owner, and an admin of the same company, who
// is told on the case page that every change they make is logged here.
//
// ?before=<iso> pages back from a time (the `next` of the page before), and
// ?limit= says how many (100 unless asked; a page never ends part-way through
// one save, so it can be a few more).
router.get('/:id/activity', requireAuth, (req, res) => {
  const r = reports.getReport(req.params.id);
  if (!r || !canView(req.user, r.userId, r.companyId)) return res.status(404).json({ error: 'Case not found' });
  const { before, limit } = req.query;
  if (before !== undefined && (typeof before !== 'string' || !Number.isFinite(Date.parse(before)))) {
    return res.status(400).json({ error: 'before must be a time, as the `next` of the page before gave it' });
  }
  if (limit !== undefined && (!/^\d+$/.test(String(limit)) || Number(limit) < 1 || Number(limit) > MAX_LIMIT)) {
    return res.status(400).json({ error: `limit must be a whole number from 1 to ${MAX_LIMIT}` });
  }
  res.json(caseActivity(r, { before: before || null, limit: limit === undefined ? undefined : Number(limit) }));
});

module.exports = router;
