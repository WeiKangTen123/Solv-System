const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { canView } = require('../middleware/roles');
const asyncHandler = require('../middleware/async-handler');
const reports = require('../store/reports');
const allowances = require('../reports/allowances');
const { caseView } = require('./reports');

// Per diem and mileage on a case (reports/allowances.js), mounted under
// /api/reports beside the case routes. Both answer with the same case view
// GET /api/reports/:id gives, so the page swaps in what comes back exactly as
// it does after filing a receipt; `expenseId` says which row is new.
//
// Seeing the case is the owner and an admin monitoring (404 for anyone else,
// as for every case route); adding to it is the owner's alone, while it is
// still taking receipts. Those two answers come from the module, as 403 and
// 409, with a 400 that says what is missing for anything else.
function _load(req, res) {
  const r = reports.head(req.params.id);
  if (!r || !canView(req.user, r.userId, r.companyId)) { res.status(404).json({ error: 'Case not found' }); return null; }
  return r;
}
// A refusal carries its status (utils/http-error); anything without one is a
// fault, and goes on to the error handler to be logged.
function _answer(res, err) {
  if (!err.status) throw err;
  res.status(err.status).json({ error: err.message });
}

// POST /:id/per-diem { country? } — the trip's days at the country's rate,
// replacing the per diem the case had. Without a country, the one the
// receipts were spent in.
router.post('/:id/per-diem', requireAuth, asyncHandler(async (req, res) => {
  const r = _load(req, res); if (!r) return;
  let out;
  try { out = await allowances.addPerDiem(r.id, req.user, req.body || {}); }
  catch (err) { return _answer(res, err); }
  res.json({ ...caseView(out.report, req), expenseId: out.expense.id });
}));

// POST /:id/mileage { date, from, to, km, returnTrip, purpose } — a drive at
// the company's rate per km.
router.post('/:id/mileage', requireAuth, asyncHandler(async (req, res) => {
  const r = _load(req, res); if (!r) return;
  let out;
  try { out = await allowances.addMileage(r.id, req.user, req.body || {}); }
  catch (err) { return _answer(res, err); }
  res.json({ ...caseView(out.report, req), expenseId: out.expense.id });
}));

module.exports = router;
