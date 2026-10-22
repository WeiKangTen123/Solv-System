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
const coverAuto = require('../reports/cover-auto');
const { flagsFor } = require('../receipts/flags');
const { localDate } = require('../utils/zone-date');
const { intakeView } = require('../reports/intake-view');
const { reportPayload } = require('../reports/expense-payload');
const exporter = require('../reports/expense-export');
const doc     = require('../reports/expense-doc');
const logger  = require('../utils/logger');

// Cases: the cover, the receipts filed under it, draft, open or claimed, and
// the exports. Seeing one: the owner, and an admin of the same company
// monitoring. Doing anything to one — the cover, filing, checking, claiming,
// reopening, deleting, merging, posting to Xero — the owner alone.
//
// A draft is the case the New case page makes when the first file lands. It
// takes receipts and edits like an open case, has no number until its owner
// creates it (POST /:id/open), and cannot be claimed, exported or posted.
function _load(req, res) {
  const r = reports.getReport(req.params.id);
  if (!r || !canView(req.user, r.userId, r.companyId)) { res.status(404).json({ error: 'Case not found' }); return null; }
  return r;
}
const OWNER_ONLY = 'Only the person whose case this is can change it.';
const _owns = (req, r) => isOwner(req.user, r.userId, r.companyId);
// The company's currency and day, for the flags: "in the future" is the
// company's today, not the server's, which runs in UTC.
function _flagOptions(companyId) {
  const c = users.getCompany(companyId) || {};
  return { baseCurrency: c.baseCurrency || 'SGD', today: localDate(c.timezone || 'Asia/Singapore') };
}
function _view(r, req) {
  const tenant = require('../xero/token-cache').getPersistedTenants(r.companyId)[0] || null;
  const opts = _flagOptions(r.companyId);
  // Every receipt says what is wrong with it (receipts/flags.js), worked out
  // now and never stored.
  const report = { ...r, expenses: r.expenses.map(e => ({ ...e, flags: flagsFor(e, r, opts) })) };
  // Correcting a receipt's details is wider than acting on the case: the
  // owner or an admin, open or claimed, until it is in Xero (receipts/edit.js).
  return { report, editable: wf.isEditable(r), isOwner: r.userId === req.user.id, posted: !!r.xeroInvoiceId,
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

// The list's query, checked: a value the list does not know is a 400 that
// says what it takes, not an empty list that looks like "you have none".
// Repeated parameters (?status=open&status=draft) are a list like a comma one.
const LIST = { status: ['draft', 'open', 'claimed'], kind: ['trip', 'period', 'case'], sort: ['newest', 'oldest', 'amount', 'dates'] };
const LIMIT_MAX = 200, Q_MAX = 100;
const _words = list => `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
function _listQuery(query) {
  const out = {};
  for (const k of ['status', 'kind']) {
    if (query[k] === undefined || query[k] === '') continue;
    const list = (Array.isArray(query[k]) ? query[k] : [query[k]]).flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
    if (!list.length || list.some(v => !LIST[k].includes(v))) throw new Error(`${k} must be ${_words(LIST[k])}, or several of them separated by commas`);
    out[k] = list;
  }
  if (query.sort !== undefined) {
    if (!LIST.sort.includes(query.sort)) throw new Error(`sort must be ${_words(LIST.sort)}`);
    out.sort = query.sort;
  }
  for (const k of ['ready', 'posted']) {
    if (query[k] === undefined) continue;
    if (query[k] !== '1' && query[k] !== '0') throw new Error(`${k} must be 1 or 0`);
    out[k] = query[k];
  }
  if (out.ready === '0') delete out.ready;   // "not only the ready ones" is every one
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!/^\d+$/.test(String(query.limit)) || n < 1 || n > LIMIT_MAX) throw new Error(`limit must be a whole number from 1 to ${LIMIT_MAX}`);
    out.limit = n;
  }
  if (query.offset !== undefined) {
    if (!/^\d+$/.test(String(query.offset))) throw new Error('offset must be a whole number from 0 up');
    out.offset = Number(query.offset);
  }
  if (query.q !== undefined) {
    if (typeof query.q !== 'string') throw new Error('q must be text');
    out.q = query.q.trim().slice(0, Q_MAX);
  }
  if (query.owner !== undefined && typeof query.owner !== 'string') throw new Error('owner must be a person\'s id');
  return out;
}

// GET / — the cases list, with the counts the tabs show. Without a limit
// every case comes back, as Home has always asked for them.
router.get('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  let opts;
  try { opts = _listQuery(req.query); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  // 'all' is the admin's monitoring view, optionally of one person; anyone
  // else asking for it, or for somebody else's, gets their own.
  const wide = String(req.query.scope || 'mine') === 'all' && me.role === 'admin';
  const scope = wide ? { companyId: me.companyId, owner: req.query.owner || undefined } : { userId: me.id };
  const { rows, total, counts } = reports.listReports({ ...scope, ...opts });
  res.json({ reports: rows, total, counts });
});

const _truthy = v => v === true || v === 1 || v === '1' || v === 'true';

// POST / — a case, open with a number as it always was; or with draft: true,
// the draft the New case page files into before its owner has said what it is.
router.post('/', requireAuth, (req, res) => {
  const me = users.findById(req.user.id);
  let r;
  try {
    const body = req.body || {};
    const patch = _coverPatch(body);
    r = reports.createReport({ companyId: me.companyId, userId: me.id, ...patch, advances: patch.advances || 0, draft: _truthy(body.draft) });
  } catch (err) { return res.status(400).json({ error: err.message }); }
  res.status(201).json(_view(r, req));
});

// POST /:id/open — "Create case". Whatever cover came with it is saved first
// and is the owner's; the number is taken now, so a draft that was never
// created never spent one.
router.post('/:id/open', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!_owns(req, r)) return res.status(403).json({ error: OWNER_ONLY });
  const already = 'This case has already been created.';
  if (r.status !== 'draft') return res.status(409).json({ error: already });
  let patch;
  try { patch = _coverPatch(req.body || {}); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const out = reports.openDraft(r.id, patch, req.user.id);
  if (!out) return res.status(409).json({ error: already });          // a second click got there second
  logger.info('Case created from a draft', { id: r.id, number: out.number, by: req.user.id });
  res.json(_view(out, req));
});

router.get('/:id', requireAuth, (req, res) => { const r = _load(req, res); if (r) res.json(_view(r, req)); });

// What the New case page and the case page poll while receipts go in: each
// file, how far its read has got, what came out of it, and what the AI makes
// of the case so far (reports/intake-view.js). The rate limiter leaves it out
// (index.js): a page asks every two seconds for as long as reads run.
router.get('/:id/intake', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  res.json(intakeView(r, _flagOptions(r.companyId)));
});

// The cover, while the case takes edits. Every cover field sent becomes the
// owner's (store/reports.js updateReport), and the AI stops writing it.
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
//
// ?withReceipts=1 deletes a draft and every receipt in it, files included:
// "Discard" on the New case page, where the receipts were dropped a minute
// ago and belong nowhere else. Only a draft: an open case's receipts are a
// claim in progress, and are taken out or deleted one at a time. Their read
// jobs go with them (the foreign key cascades). Without it, the receipts are
// left outside any case, as they always were.
router.delete('/:id', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!_owns(req, r)) return res.status(403).json({ error: OWNER_ONLY });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} case cannot be deleted` });
  if (req.query.ifEmpty === '1' && r.expenses.length) return res.status(409).json({ error: 'This case has receipts in it, so it was kept.', kept: true });
  const withReceipts = req.query.withReceipts === '1';
  if (withReceipts && r.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be deleted with its receipts. Take the receipts out of this case, or delete them one by one.' });
  let removed = 0;
  if (withReceipts) {
    const { removeExpense } = require('../receipts/remove');
    // A case only ever holds its owner's receipts; one that got in some other
    // way is left, outside any case, rather than deleted by somebody else.
    for (const e of r.expenses) if (e.userId === r.userId) { removeExpense(e); removed++; }
  }
  reports.deleteReport(r.id);
  logger.info('Report deleted', { id: r.id, number: r.number, status: r.status, receiptsDeleted: removed, by: req.user.id });
  res.json({ ok: true, ...(withReceipts ? { receiptsDeleted: removed } : {}) });
});

// POST /:id/merge { into } — two cases that turned out to be one: a draft
// whose receipts belong to a trip already open, or two drafts for one trip.
// Both the owner's, both still taking receipts. Every receipt moves to
// `into`, whose history says where they came from, and this case goes.
router.post('/:id/merge', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!_owns(req, r)) return res.status(403).json({ error: OWNER_ONLY });
  const into = (req.body || {}).into;
  if (!into || typeof into !== 'string') return res.status(400).json({ error: 'Say which case to merge into.' });
  if (into === r.id) return res.status(400).json({ error: 'A case cannot be merged into itself.' });
  const t = reports.head(into);
  if (!t || !canView(req.user, t.userId, t.companyId)) return res.status(404).json({ error: 'Case not found' });
  if (!isOwner(req.user, t.userId, t.companyId)) return res.status(403).json({ error: OWNER_ONLY });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} case cannot be merged` });
  if (!wf.isEditable(t)) return res.status(409).json({ error: `A ${t.status} case cannot take more receipts` });
  const moved = reports.mergeInto(r.id, t.id, req.user.id);
  // The receipts moved; the cover the AI keeps follows them (cover-auto.js).
  coverAuto.refresh(t.id);
  logger.info('Cases merged', { from: r.id, into: t.id, number: t.number, moved, by: req.user.id });
  res.json(_view(reports.getReport(t.id), req));
});

// File receipts in this case, through the one rule for filing
// (receipts/edit.js fileInCase): the owner's own, not a duplicate, not
// claimed on its own, both ends still taking receipts. A receipt goes in
// whether or not it has been checked yet: working case-first, receipts are
// filed as they arrive and checked in the case. One already in another case
// moves only when `move: true` says so and that case is not claimed. The
// rest come back in `skipped`, each with why.
router.post('/:id/expenses', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!_owns(req, r)) return res.status(403).json({ error: OWNER_ONLY });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} case cannot take more receipts` });
  const body = req.body || {};
  const ids = Array.isArray(body.expenseIds) ? body.expenseIds : [];
  const move = _truthy(body.move);
  const edit = require('../receipts/edit');
  const skipped = [], left = new Set();
  let filed = 0;
  for (const id of ids) {
    const e = typeof id === 'string' ? store.getExpense(id) : null;
    if (!e || e.userId !== r.userId) { skipped.push({ id, why: 'not found' }); continue; }
    if (e.reportId === r.id) continue;
    if (e.reportId && (!move || wf.isLocked(e))) { skipped.push({ id, why: 'already in another case' }); continue; }
    // Said shortly, as they always were; the page lists them under the case.
    if (e.status === 'duplicate') { skipped.push({ id, why: 'a duplicate' }); continue; }
    if (e.claimedAt && !e.reportId) { skipped.push({ id, why: 'already claimed on its own' }); continue; }
    try {
      edit.fileInCase(e.id, r.id, req.user);
      filed++;
      if (e.reportId) left.add(e.reportId);
    } catch (err) {
      if (!err.status) throw err;
      skipped.push({ id, why: err.message.replace(/^./, c => c.toLowerCase()) });
    }
  }
  // The cover the AI keeps follows the receipts, here and where they left.
  if (filed) for (const id of [r.id, ...left]) coverAuto.refresh(id);
  res.json({ ..._view(reports.getReport(r.id), req), skipped });
});

router.delete('/:id/expenses/:expenseId', requireAuth, (req, res) => {
  const r = _load(req, res); if (!r) return;
  if (!_owns(req, r)) return res.status(403).json({ error: OWNER_ONLY });
  if (!wf.isEditable(r)) return res.status(409).json({ error: `A ${r.status} case cannot be changed` });
  if (!reports.removeExpense(r.id, req.params.expenseId)) return res.status(404).json({ error: 'That receipt is not in this case' });
  coverAuto.refresh(r.id);
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
  // A draft has no number, and an export is filed and printed by its number.
  if (r.status === 'draft') return res.status(409).json({ error: 'A draft cannot be exported. Create the case first.' });
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
module.exports.caseView = _view;   // routes/allowances.js answers with the same case view
