const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { requireRole } = require('../middleware/roles');
const users   = require('../store/users');
const policy  = require('../store/policy');
const { CATEGORY_NAMES } = require('../intake/categories');
const logger  = require('../utils/logger');

// The company's policy and per-diem rates (store/policy.js), mounted under
// /api/company beside the company settings. Anyone signed in reads them: the
// case page needs the mileage rate to show what a drive comes to, and a
// person adding a per diem should see the rate it will use. Only an admin
// changes them, like every other company setting.

// A refusal carries its status (utils/http-error); anything without one is a
// fault, and goes on to the error handler to be logged.
function _answer(res, err) {
  if (!err.status) throw err;
  res.status(err.status).json({ error: err.message });
}

// The policy with what the settings page needs to show it: the currency the
// mileage rate and the limits are in, and the categories a limit can be set
// for.
function _policyView(companyId) {
  const c = users.getCompany(companyId) || {};
  return { policy: policy.getPolicy(companyId), baseCurrency: c.baseCurrency || 'SGD', categories: CATEGORY_NAMES, ...policy.policyChange(companyId) };
}

router.get('/policy', requireAuth, (req, res) => res.json(_policyView(req.user.companyId)));

// Only the settings sent change; each is checked, and an unknown one refused.
router.put('/policy', requireAuth, requireRole('admin'), (req, res) => {
  try { policy.setPolicy(req.user.companyId, req.body, req.user.id); }
  catch (err) { return _answer(res, err); }
  logger.info('Company policy changed', { companyId: req.user.companyId, settings: Object.keys(req.body || {}), by: req.user.id });
  res.json(_policyView(req.user.companyId));
});

router.get('/per-diem-rates', requireAuth, (req, res) => res.json({ rates: policy.listRates(req.user.companyId) }));

// A new rate from a date. A rate is never edited: the day it changes is a
// new rate, so the days before it keep theirs.
router.post('/per-diem-rates', requireAuth, requireRole('admin'), (req, res) => {
  const b = req.body || {};
  let rate;
  try { rate = policy.addRate({ companyId: req.user.companyId, country: b.country, currency: b.currency, dailyAmount: b.dailyAmount, effectiveFrom: b.effectiveFrom, createdBy: req.user.id }); }
  catch (err) { return _answer(res, err); }
  logger.info('Per-diem rate added', { companyId: req.user.companyId, country: rate.country, currency: rate.currency, from: rate.effectiveFrom, by: req.user.id });
  res.status(201).json({ rate, rates: policy.listRates(req.user.companyId) });
});

router.delete('/per-diem-rates/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (!policy.deleteRate(req.user.companyId, req.params.id)) return res.status(404).json({ error: 'Rate not found' });
  logger.info('Per-diem rate deleted', { companyId: req.user.companyId, id: req.params.id, by: req.user.id });
  res.json({ ok: true, rates: policy.listRates(req.user.companyId) });
});

module.exports = router;
