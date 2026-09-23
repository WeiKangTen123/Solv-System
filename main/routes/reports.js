const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
const { canAccessUser } = require('../middleware/roles');
const asyncHandler = require('../middleware/async-handler');
const users   = require('../store/users');
const store   = require('../store/expenses');
const reports = require('../store/reports');
const wf      = require('../reports/workflow');
const { reportPayload } = require('../reports/expense-payload');
const exporter = require('../reports/expense-export');
const doc     = require('../reports/expense-doc');
const logger  = require('../utils/logger');

// Expense reports: the cover, the expenses filed under it, the workflow, and
// the exports. Access: the owner, the owner's manager, finance and admin.
function _load(req, res) {
  const r = reports.getReport(req.params.id);
  if (!r || !canAccessUser(req.user, r.userId)) { res.status(404).json({ error: 'Report not found' }); return null; }
  return r;
}
// canDecide means "can act on it now": the right person, and a report awaiting a decision.
function _view(r, req) {
  const tenant = require('../xero/token-cache').getPersistedTenants(r.companyId)[0] || null;
  return { report: r, canDecide: ['submitted', 'approved'].includes(r.status) && wf.canDecide(r.id, req.user), editable: wf.isEditable(r), isOwner: r.userId === req.user.id,
           xero: { connected: !!tenant, tenantName: tenant ? tenant.tenantName : null } };
}
// A workflow error about WHO may act is a 403; anything else is a 400.
function _fail(res, err) {
  const who = /\bonly\b|cannot decide|own report/i.test(err.message);
  res.status(who ? 403 : 400).json({ error: err.message });
}
const COVER = ['kind', 'title', 'purpose', 'periodFrom', 'periodTo', 'destination', 'nights', 'advances', 'notes'];
function _coverPatch(body) {
  const patch = {};
  for (const k of COVER) if (body[k] !== undefined) patch[k] = body[k] === '' ? null : body[k];
  for (const k of ['periodFrom', 'periodTo']) if (patch[k] && !/^\d{4}-\d{2}-\d{2}$/.test(String(patch[k]))) throw new Error(`${k === 'periodFrom' ? 'From' : 'To'} must be YYYY-MM-DD`);
  // 'case' was added to the store, the schema and the printed cover and missed
  // here, so every case created through the UI was refused by its own route.
  if (patch.kind && !['trip', 'period', 'case'].includes(patch.kind)) throw new Error('kind must be trip, period or case');
  if (patch.advances !== undefined && patch.advances !== null && !(Number(patch.advances) >= 0)) throw new Error('Advances must be a number');
  if (patch.nights !== undefined && patch.nights !== null) patch.nights = Number(patch.nights) >= 0 ? Math.round(Number(patch.nights)) : null;
  return patch;
}

router.get('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  const scope = String(req.query.scope || 'mine');
  const status = req.query.status || undefined;
  let list;
  if (scope === 'all' && (me.role === 'finance' || me.role === 'admin')) list = reports.listReports({ companyId: me.companyId, status });
  else if (scope === 'team' && me.role === 'manager') list = reports.listReports({ userIds: users.getAllUsers(me.companyId).filter(u => u.managerId === me.id).map(u => u.id), status });
  else list = reports.listReports({ userId: me.id, status });
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

// What is waiting on this person: a manager's direct reports' submitted
// reports; for finance and admin, everything submitted or approved.
router.get('/queue', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  if (me.role === 'finance' || me.role === 'admin') return res.json({ reports: reports.listReports({ companyId: me.companyId, status: 'submitted,approved' }).filter(r => r.userId !== me.id) });
  if (me.role === 'manager') return res.json({ reports: reports.listReports({ userIds: users.getAllUsers(me.companyId).filter(u => u.managerId === me.id).map(u => u.id), status: 'submitted' }) });
  res.json({ reports: [] });
});

router.get('/:id', requireAuth, (req, res) => { const r = _load(req, res); if (r) res.json(_view(r, req)); });

router.patch('/:id', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (r.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the report owner can edit it' });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} report cannot be edited` });
  try { res.json(_view(reports.updateReport(r.id, _coverPatch(req.body || {})), req)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (r.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the report owner can delete it' });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} report cannot be deleted` });
  reports.deleteReport(r.id);
  logger.info('Report deleted', { id: r.id, number: r.number, by: req.user.email });
  res.json({ ok: true });
});

// File expenses. Only the owner's own reviewed expenses that are not in
// another report; the rest come back in `skipped` with a reason.
router.post('/:id/expenses', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (r.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the report owner can file expenses' });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} report cannot take more expenses` });
  const ids = Array.isArray((req.body || {}).expenseIds) ? req.body.expenseIds : [];
  const skipped = [];
  for (const id of ids) {
    const e = store.getExpense(id);
    if (!e || e.userId !== r.userId) { skipped.push({ id, why: 'not found' }); continue; }
    if (e.reportId && e.reportId !== r.id) { skipped.push({ id, why: 'already in another report' }); continue; }
    if (e.status !== 'reviewed') { skipped.push({ id, why: 'not marked reviewed yet' }); continue; }
    reports.addExpense(r.id, e.id);
  }
  res.json({ ..._view(reports.getReport(r.id), req), skipped });
});

router.delete('/:id/expenses/:expenseId', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (r.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the report owner can remove expenses' });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} report cannot be changed` });
  if (!reports.removeExpense(r.id, req.params.expenseId)) return res.status(404).json({ error: 'That expense is not in this report' });
  res.json(_view(reports.getReport(r.id), req));
});

// One route per transition, spelled out: the UI path scanner reads literal
// paths, and a reader of this file should not have to unroll a loop.
function _transition(action, fn) {
  return (req, res) => {
    const r = _load(req, res); if (!r) return;
    try { const out = fn(r, req); logger.info(`Report ${action}`, { id: r.id, number: r.number, by: req.user.email }); res.json(_view(out, req)); }
    catch (err) { _fail(res, err); }
  };
}
router.post('/:id/submit',  requireAuth, _transition('submitted', (r, req) => wf.submit(r.id, req.user)));
router.post('/:id/approve', requireAuth, _transition('approved',  (r, req) => wf.approve(r.id, req.user)));
router.post('/:id/reject',  requireAuth, _transition('rejected',  (r, req) => wf.reject(r.id, req.user, (req.body || {}).reason)));
router.post('/:id/claimed', requireAuth, _transition('claimed',   (r, req) => wf.markClaimed(r.id, req.user)));

// POST /:id/post — finance sends the approved report to Xero as one draft bill.
// ?dryRun=1 answers with the bill that would be sent and sends nothing.
router.post('/:id/post', requireAuth, asyncHandler(async (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!(req.user.role === 'finance' || req.user.role === 'admin')) return res.status(403).json({ error: 'Only finance can post a report to Xero' });
  try {
    const out = await require('../xero/bills').postReport(r.id, req.user, { dryRun: req.query.dryRun === '1' });
    res.json({ ...out, ...(_view(reports.getReport(r.id), req)) });
  } catch (err) {
    const status = /not connected|approved|already in Xero/i.test(err.message) ? 400 : 502;
    res.status(status).json({ error: err.message, ...(_view(reports.getReport(r.id), req)) });
  }
}));

// Marking a whole case checked in one call. The rule is exactly the one the
// single-expense route applies, asked of each in turn, and anything it cannot
// pass comes back saying why rather than failing the lot. Checking thirty
// receipts one page at a time is the slowest part of a claim.
router.post('/:id/review-all', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (r.userId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the claimant can check their own receipts' });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} case cannot be changed` });

  const store = require('../store/expenses');
  const reviewed = [], skipped = [];
  for (const e of r.expenses) {
    if (e.status === 'reviewed') continue;
    // A report should only ever hold its owner's expenses, but this loop is the
    // one place that would launder somebody else's into a claim if one ever got
    // in, so it asks rather than assuming.
    if (e.userId !== r.userId) { skipped.push({ id: e.id, merchant: e.merchant, why: 'it belongs to someone else' }); continue; }
    if (e.status === 'duplicate') { skipped.push({ id: e.id, merchant: e.merchant, why: 'it is a duplicate' }); continue; }
    if (e.status === 'reading')   { skipped.push({ id: e.id, merchant: e.merchant, why: 'it is still being read' }); continue; }
    const missing = [];
    if (!e.merchant) missing.push('merchant');
    if (!e.receiptDate) missing.push('date');
    if (!e.currency) missing.push('currency');
    if (!(e.total > 0)) missing.push('total');
    if (missing.length) { skipped.push({ id: e.id, merchant: e.merchant, why: `no ${missing.join(', ')}` }); continue; }
    if (!store.linesReconcile(e.lines, store.toCents(e.total))) { skipped.push({ id: e.id, merchant: e.merchant, why: 'the lines do not add up to the total' }); continue; }
    store.updateExpense(e.id, { status: 'reviewed' });
    reviewed.push(e.id);
  }
  if (reviewed.length) reports.addEvent(r.id, req.user.id, 'checked', `${reviewed.length} receipt${reviewed.length === 1 ? '' : 's'}`);
  logger.info('Case checked in bulk', { id: r.id, number: r.number, reviewed: reviewed.length, skipped: skipped.length, by: req.user.email });
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
  const token = jwt.sign({ purpose: 'report-export', reportId: r.id, format, userId: req.user.id }, jwtSecret(), { expiresIn: '5m' });
  res.json({ url: `/api/reports/${r.id}/export?token=${encodeURIComponent(token)}`, expiresIn: '5m' });
});

function setDownloadName(res, base, ext, inline) {
  const raw = `${base}.${ext}`;
  // eslint-disable-next-line no-control-regex
  const ascii = raw.replace(/[^\x20-\x7e]/g, '').replace(/"/g, "'").trim() || `export.${ext}`;
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`);
}

router.get('/:id/export', asyncHandler(async (req, res) => {
  let spec;
  try { spec = jwt.verify(String(req.query.token || ''), jwtSecret()); if (spec.purpose !== 'report-export' || spec.reportId !== req.params.id) throw new Error('scope'); }
  catch { return res.status(401).type('text/plain').send('This export link has expired. Generate it again.'); }
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
