const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { requireRole } = require('../middleware/roles');
const asyncHandler = require('../middleware/async-handler');
const users = require('../store/users');
const rates = require('../fx/rates');
const live  = require('../fx/live');

// Exchange rates: the live board and its daily log for anyone signed in, and
// for an admin the watch list, the live source, and rates typed in for a day
// (a monthly table, or a correction).
const companyOf = req => users.findById(req.user.id).companyId;
const CODE = /^[A-Z]{3}$/;

// GET /api/fx/rate?from=INR&date=2026-09-04   (to = the company base unless given)
router.get('/rate', requireAuth, asyncHandler(async (req, res) => {
  const me = users.findById(req.user.id);
  const to = String(req.query.to || users.getCompany(me.companyId).baseCurrency).toUpperCase();
  const from = String(req.query.from || '').toUpperCase();
  if (!CODE.test(from)) return res.status(400).json({ error: 'from must be a 3-letter currency code' });
  const r = await rates.getRate({ from, to, date: req.query.date || undefined });
  if (!r) return res.status(404).json({ error: `No rate for ${from} to ${to}` });
  res.json({ rate: r });
}));

router.get('/rates', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  res.json({ rates: rates.listRates({ to: req.query.to || users.getCompany(me.companyId).baseCurrency, from: req.query.from || undefined, since: req.query.since || undefined }) });
});

router.post('/rates', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const { from, to, date, rate } = req.body || {};
    res.status(201).json({ rate: rates.setManualRate({ from, to: to || users.getCompany(me.companyId).baseCurrency, date, rate, by: req.user.email }) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/rates', requireAuth, requireRole('admin'), (req, res) => {
  const { from, to, date } = req.query;
  if (!rates.deleteManualRate({ from: String(from || '').toUpperCase(), to: String(to || '').toUpperCase(), date })) return res.status(404).json({ error: 'No manual rate on that day' });
  res.json({ ok: true });
});

// ── The live board ──────────────────────────────────────────────────────────
router.get('/board', requireAuth, (req, res) => res.json(live.board(companyOf(req))));

router.get('/log/:currency', requireAuth, (req, res) => {
  const ccy = String(req.params.currency || '').toUpperCase();
  if (!CODE.test(ccy)) return res.status(400).json({ error: 'Currency must be a 3-letter code' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 366);
  res.json(live.log(companyOf(req), ccy, { limit }));
});

// Watching a currency fetches it straight away, so the row arrives with a
// rate, and with yesterday's as its last close so it shows a move today.
router.post('/watch', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  let ccy;
  try { ccy = live.watch(companyId, (req.body || {}).currency, req.user.email); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  await live.refresh(companyId);
  await live.backfill(companyId, ccy).catch(() => null);
  res.status(201).json(live.board(companyId));
}));

router.delete('/watch/:currency', requireAuth, requireRole('admin'), (req, res) => {
  const companyId = companyOf(req);
  if (!live.unwatch(companyId, req.params.currency)) return res.status(404).json({ error: 'That currency was not added by hand; receipts keep it on the board' });
  res.json(live.board(companyId));
});

router.post('/live/refresh', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const out = await live.refresh(companyId, { manual: true });
  if (out && out.throttled) return res.status(429).json({ error: `Refreshed a moment ago. Try again in ${Math.ceil(out.retryInMs / 1000)} seconds.` });
  res.json({ ...live.board(companyId), refresh: out });
}));

// The live source: an Open Exchange Rates App ID, checked against the
// provider before it is kept. An empty one goes back to the daily feeds.
router.put('/live/source', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  try { await live.setOxrKey(companyId, (req.body || {}).appId); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  await live.refresh(companyId);
  res.json(live.board(companyId));
}));

module.exports = router;
