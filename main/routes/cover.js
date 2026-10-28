const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const { canView, isOwner } = require('../middleware/roles');
const reports = require('../store/reports');
const wf      = require('../reports/workflow');
const coverAuto = require('../reports/cover-auto');
const help    = require('../reports/cover-help');
const logger  = require('../utils/logger');
const { caseView, flagOptions } = require('./reports');

// The help a case's details get from its receipts (reports/cover-help.js),
// mounted under /api/reports beside the case routes.
//
//   GET  /:id/cover-suggestions  what the AI would put in each field beside
//        what the case has, the receipts it was made from, and the purpose
//        choices. The owner, and an admin monitoring, may see it; the
//        person's earlier purposes are for the owner alone, who is the one
//        who can pick one.
//   POST /:id/cover-ai { fields }  "Let the AI keep this up": fields the
//        owner set go back to the AI, which fills them from the receipts at
//        once and keeps them up from then on. The owner's, while the case
//        takes edits.
//
// Taking a suggestion is an ordinary PATCH /:id of the fields ticked, which
// makes them the owner's like anything else they type.
const OWNER_ONLY = 'Only the person whose case this is can change it.';
const FIELDS = ['kind', 'title', 'periodFrom', 'periodTo', 'destination', 'nights'];

function _load(req, res) {
  const r = reports.getReport(req.params.id);
  if (!r || !canView(req.user, r.userId, r.companyId)) { res.status(404).json({ error: 'Case not found' }); return null; }
  return r;
}
// The fields the AI can keep on a case in this state: all of a draft's, the
// dates, where and the nights of an open one (reports/cover-auto.js), and
// nothing once it is claimed.
const _keepable = r => (r.status === 'draft' ? coverAuto.DRAFT_FIELDS : r.status === 'open' ? coverAuto.OPEN_FIELDS : []);

router.get('/:id/cover-suggestions', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  const opts = flagOptions(r.companyId);
  const s = help.caseSuggestion(r, opts);
  const owner = isOwner(req.user, r.userId, r.companyId);
  res.json({
    fields: s ? Object.fromEntries(FIELDS.map(f => [f, s[f] ?? null])) : null,
    current: { ...Object.fromEntries(FIELDS.map(f => [f, r[f] ?? null])), purpose: r.purpose ?? null },
    coverAi: r.coverAi,
    basis: s ? s.basis : null,
    aiCanKeep: wf.isEditable(r) ? _keepable(r) : [],
    purposeDraft: help.purposeDraft(r, opts),
    pastPurposes: owner ? help.pastPurposes(r.userId, { exceptCase: r.id, except: r.purpose }) : [],
  });
});

router.post('/:id/cover-ai', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!isOwner(req.user, r.userId, r.companyId)) return res.status(403).json({ error: OWNER_ONLY });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} case cannot be edited` });
  const asked = (req.body || {}).fields;
  const list = Array.isArray(asked) ? [...new Set(asked)] : [];
  const keepable = _keepable(r);
  if (!list.length || list.some(f => typeof f !== 'string')) return res.status(400).json({ error: 'Say which fields the AI should keep up.' });
  const wrong = list.filter(f => !keepable.includes(f));
  if (wrong.length) {
    return res.status(400).json({ error: r.status === 'draft'
      ? `The AI does not fill ${wrong.join(', ')}.`
      : `On a case already created the AI keeps up only the dates, where and the nights, not ${wrong.join(', ')}.` });
  }
  const ai = r.coverAi;
  reports.setCoverAi(r.id, { auto: [...new Set([...ai.auto, ...list])], user: ai.user.filter(f => !list.includes(f)) });
  const out = coverAuto.refresh(r.id);
  logger.info('Case details handed back to the AI', { id: r.id, fields: list, changed: out ? out.changed : [], by: req.user.id });
  res.json({ ...caseView(reports.getReport(r.id), req), changed: out ? out.changed : [] });
});

module.exports = router;
