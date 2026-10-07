const express = require('express');
const router  = express.Router();
const link    = require('../utils/signed-link');
const { requireAuth } = require('../middleware/auth-middleware');
const { canView, isOwner, canEditDetails } = require('../middleware/roles');
const asyncHandler = require('../middleware/async-handler');
const users   = require('../store/users');
const store   = require('../store/expenses');
const reports = require('../store/reports');
const wf      = require('../reports/workflow');
const { reportPayload } = require('../reports/expense-payload');
const exporter = require('../reports/expense-export');
const doc     = require('../reports/expense-doc');
const logger  = require('../utils/logger');

// Cases: the cover, the receipts filed under it, open or claimed, and the
// exports. Seeing one: the owner, and an admin of the same company monitoring.
// Doing anything to one — the cover, filing, checking, claiming, reopening,
// deleting, posting to Xero — the owner alone.
function _load(req, res) {
  const r = reports.getReport(req.params.id);
  if (!r || !canView(req.user, r.userId, r.companyId)) { res.status(404).json({ error: 'Case not found' }); return null; }
  return r;
}
const OWNER_ONLY = 'Only the person whose case this is can change it.';
const _owns = (req, r) => isOwner(req.user, r.userId, r.companyId);
function _view(r, req) {
  const tenant = require('../xero/token-cache').getPersistedTenants(r.companyId)[0] || null;
  // Correcting a receipt's details is wider than acting on the case: the
  // owner or an admin, open or claimed, until it is in Xero (receipts/edit.js).
  return { report: r, editable: wf.isEditable(r), isOwner: r.userId === req.user.id, posted: !!r.xeroInvoiceId,
           canEditDetails: !r.xeroInvoiceId && canEditDetails(req.user, r.userId, r.companyId),
           xero: { connected: !!tenant, tenantName: tenant ? tenant.tenantName : null } };
}
// A workflow refusal carries its status (utils/http-error): who may act is a
// 403, a state that does not allow it a 409, the content a 400. Anything
// without one is a fault, and goes to the error handler to be logged.
function _fail(res, err) {
  if (!err.status) throw err;
  res.status(err.status).json({ error: err.message });
}
const COVER = ['kind', 'title', 'purpose', 'periodFrom', 'periodTo', 'destination', 'nights', 'advances', 'notes'];
const MAX_ADVANCE = 10000000;
// The cover's words, each text and of a sane length. An object for a title
// reached the database driver, whose own message ("Too few parameter values")
// came back to the person as the error.
const TEXT_MAX = { title: 200, purpose: 500, destination: 120, notes: 2000 };
function _coverPatch(body) {
  const patch = {};
  for (const k of COVER) if (body[k] !== undefined) patch[k] = body[k] === '' ? null : body[k];
  for (const [k, max] of Object.entries(TEXT_MAX)) {
    if (patch[k] === undefined || patch[k] === null) continue;
    if (typeof patch[k] !== 'string') throw new Error(`${k[0].toUpperCase()}${k.slice(1)} must be text`);
    patch[k] = patch[k].trim().slice(0, max) || null;
  }
  for (const k of ['periodFrom', 'periodTo']) {
    if (patch[k] && !require('../intake/document').isoDate(String(patch[k]), { allowFuture: true })) throw new Error(`${k === 'periodFrom' ? 'From' : 'To'} must be a real date, YYYY-MM-DD`);
  }
  // 'case' was added to the store, the schema and the printed cover and missed
  // here, so every case created through the UI was refused by its own route.
  if (patch.kind && !['trip', 'period', 'case'].includes(patch.kind)) throw new Error('kind must be trip, period or case');
  // A finite amount, and not an absurd one: "1e400" passed ">= 0" as
  // Infinity, showed as 0.00 on screen and printed as "∞" on the PDF.
  if (patch.advances !== undefined && patch.advances !== null) {
    const n = Number(patch.advances);
    if (!Number.isFinite(n) || n < 0 || n > MAX_ADVANCE) throw new Error(`Advances must be an amount from 0 to ${MAX_ADVANCE.toLocaleString('en')}`);
  }
  if (patch.nights !== undefined && patch.nights !== null) patch.nights = Number(patch.nights) >= 0 ? Math.round(Number(patch.nights)) : null;
  return patch;
}

router.get('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  const scope = String(req.query.scope || 'mine');
  const status = req.query.status || undefined;
  // 'all' is the admin's monitoring view; anyone else asking for it gets their own.
  const list = scope === 'all' && me.role === 'admin'
    ? reports.listReports({ companyId: me.companyId, status })
    : reports.listReports({ userId: me.id, status });
  res.json({ reports: list });
});

router.post('/', requireAuth, (req, res) => {
  try {
    const me = users.findById(req.user.id);
    const patch = _coverPatch(req.body || {});
    const r = reports.createReport({ companyId: me.companyId, userId: me.id, ...patch, advances: patch.advances || 0 });
    res.status(201).json(_view(r, req));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/:id', requireAuth, (req, res) => { const r = _load(req, res); if (r) res.json(_view(r, req)); });

router.patch('/:id', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!_owns(req, r)) return res.status(403).json({ error: OWNER_ONLY });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} case cannot be edited` });
  try { res.json(_view(reports.updateReport(r.id, _coverPatch(req.body || {})), req)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ?ifEmpty=1 deletes only a case with nothing in it. The phone dialog makes
// a case for its session and drops it again when nothing arrived; it judged
// "nothing" from a poll up to three seconds old, so closing it just after the
// last photo deleted the case those photos had landed in.
router.delete('/:id', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!_owns(req, r)) return res.status(403).json({ error: OWNER_ONLY });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} case cannot be deleted` });
  if (req.query.ifEmpty === '1' && r.expenses.length) return res.status(409).json({ error: 'This case has receipts in it, so it was kept.', kept: true });
  reports.deleteReport(r.id);
  logger.info('Report deleted', { id: r.id, number: r.number, by: req.user.id });
  res.json({ ok: true });
});

// File expenses. Only the owner's own reviewed expenses that are not in
// another report; the rest come back in `skipped` with a reason.
router.post('/:id/expenses', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!_owns(req, r)) return res.status(403).json({ error: OWNER_ONLY });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} case cannot take more receipts` });
  const ids = Array.isArray((req.body || {}).expenseIds) ? req.body.expenseIds : [];
  const skipped = [];
  for (const id of ids) {
    const e = store.getExpense(id);
    if (!e || e.userId !== r.userId) { skipped.push({ id, why: 'not found' }); continue; }
    if (e.reportId && e.reportId !== r.id) { skipped.push({ id, why: 'already in another case' }); continue; }
    if (e.status !== 'reviewed') { skipped.push({ id, why: 'not marked reviewed yet' }); continue; }
    // Claimed on its own already: in a case it would be claimed a second time.
    if (e.claimedAt) { skipped.push({ id, why: 'already claimed on its own' }); continue; }
    reports.addExpense(r.id, e.id);
  }
  res.json({ ..._view(reports.getReport(r.id), req), skipped });
});

router.delete('/:id/expenses/:expenseId', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!_owns(req, r)) return res.status(403).json({ error: OWNER_ONLY });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} case cannot be changed` });
  if (!reports.removeExpense(r.id, req.params.expenseId)) return res.status(404).json({ error: 'That receipt is not in this case' });
  res.json(_view(reports.getReport(r.id), req));
});

// One route per transition, spelled out: the UI path scanner reads literal
// paths, and a reader of this file should not have to unroll a loop.
function _transition(action, fn) {
  return (req, res) => {
    const r = _load(req, res); if (!r) return;
    try { const out = fn(r, req); logger.info(`Report ${action}`, { id: r.id, number: r.number, by: req.user.id }); res.json(_view(out, req)); }
    catch (err) { _fail(res, err); }
  };
}
router.post('/:id/claimed', requireAuth, _transition('claimed',  (r, req) => wf.markClaimed(r.id, req.user)));
// Reopened, its receipts are priced as any open receipt is: one priced at the
// live rate whose day has since closed moves to the close. While it was
// claimed the close passed it by, and it was claimed again at the live rate.
router.post('/:id/reopen',  requireAuth, asyncHandler(async (req, res) => {
  const r = _load(req, res); if (!r) return;
  try { wf.reopen(r.id, req.user); }
  catch (err) { return _fail(res, err); }
  logger.info('Report reopened', { id: r.id, number: r.number, by: req.user.id });
  await require('../fx/apply').reprice(r.expenses.map(e => e.id));
  res.json(_view(reports.getReport(r.id), req));
}));

// POST /:id/post — the claimant sends their own claimed case to Xero as one
// draft bill, through the connection an admin set up in Settings. Posting is
// part of putting a claim through, which is the claimant's; the admin runs
// the connection and does not handle anybody's claim.
// ?dryRun=1 answers with the bill that would be sent and sends nothing.
router.post('/:id/post', requireAuth, asyncHandler(async (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!_owns(req, r)) return res.status(403).json({ error: 'Only the claimant can post their own case to Xero' });
  try {
    const out = await require('../xero/bills').postReport(r.id, req.user, { dryRun: req.query.dryRun === '1' });
    res.json({ ...out, ...(_view(reports.getReport(r.id), req)) });
  } catch (err) {
    // postReport says what kind of failure it was (utils/http-error); one it
    // did not name is ours, logged and not shown.
    if (!err.status) logger.error('Posting to Xero failed', { id: r.id, error: err.message, stack: err.stack });
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Posting failed on our side. Try again.', ...(_view(reports.getReport(r.id), req)) });
  }
}));

// Marking a whole case checked in one call. The rule is exactly the one the
// single-expense route applies, asked of each in turn, and anything it cannot
// pass comes back saying why rather than failing the lot. Checking thirty
// receipts one page at a time is the slowest part of a claim.
router.post('/:id/review-all', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!_owns(req, r)) return res.status(403).json({ error: 'Only the claimant can check their own receipts' });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} case cannot be changed` });

  const edit = require('../receipts/edit');
  const reviewed = [], skipped = [];
  for (const e of r.expenses) {
    if (e.status === 'reviewed') continue;
    // A report should only ever hold its owner's expenses, but this loop is the
    // one place that would launder somebody else's into a claim if one ever got
    // in, so it asks rather than assuming.
    if (e.userId !== r.userId) { skipped.push({ id: e.id, merchant: e.merchant, why: 'it belongs to someone else' }); continue; }
    // Exactly the single-receipt rule (receipts/edit.js), so the two cannot
    // drift apart again: this copy once kept the assumed-currency warning the
    // single route clears.
    try { edit.setStatus(e.id, 'reviewed', req.user); reviewed.push(e.id); }
    catch (err) {
      if (!err.status) throw err;
      skipped.push({ id: e.id, merchant: e.merchant, why: err.message.replace(/^./, c => c.toLowerCase()) });
    }
  }
  if (reviewed.length) reports.addEvent(r.id, req.user.id, 'checked', `${reviewed.length} receipt${reviewed.length === 1 ? '' : 's'}`);
  logger.info('Case checked in bulk', { id: r.id, number: r.number, reviewed: reviewed.length, skipped: skipped.length, by: req.user.id });
  res.json({ ..._view(reports.getReport(r.id), req), reviewed: reviewed.length, skipped });
});

router.get('/:id/events', requireAuth, (req, res) => { const r = _load(req, res); if (r) res.json({ events: r.events }); });

// ── Exports ─────────────────────────────────────────────────────────────────
// Two steps, as in the Xero app: a browser navigation cannot carry a JWT, so
// the authed call hands back a short-lived signed link and the browser opens it.
const FORMATS = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' };
router.get('/:id/export-url', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  const format = String(req.query.format || 'pdf');
  if (!FORMATS[format]) return res.status(400).json({ error: 'format must be pdf, xlsx or csv' });
  const token = link.sign('report-export', { reportId: r.id, format, userId: req.user.id });
  res.json({ url: `/api/reports/${r.id}/export?token=${encodeURIComponent(token)}`, expiresIn: '5m' });
});

function setDownloadName(res, base, ext, inline) {
  const raw = `${base}.${ext}`;
  const ascii = raw.replace(/[^\x20-\x7e]/g, '').replace(/"/g, "'").trim() || `export.${ext}`;
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`);
}

router.get('/:id/export', asyncHandler(async (req, res) => {
  const spec = link.read(req.query.token, 'report-export');
  const head = spec && spec.reportId === req.params.id ? reports.head(spec.reportId) : null;
  // Asked again now: a person removed, or an admin demoted, since the link
  // was made no longer downloads the case.
  if (!head || !FORMATS[spec.format] || !link.stillAllowed(spec.userId, head.userId, head.companyId)) {
    return res.status(401).type('text/plain').send('This export link has expired. Generate it again.');
  }
  const payload = await reportPayload(spec.reportId, { withReceipts: spec.format === 'pdf' });
  if (!payload) return res.status(404).type('text/plain').send('Report not found');
  const name = doc.exportFilename(payload);
  res.type(FORMATS[spec.format]);
  setDownloadName(res, name, spec.format, spec.format === 'pdf');
  if (spec.format === 'pdf') return res.send(await exporter.pdfBuffer(doc.expenseReportDoc(payload)));
  if (spec.format === 'xlsx') return res.send(await exporter.xlsxBuffer(payload));
  res.send(exporter.csvText(payload));
}));

module.exports = router;
