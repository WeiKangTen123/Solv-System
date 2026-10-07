const express      = require('express');
const router       = express.Router();
const { decodeBase64 } = require('../utils/base64');
const { requireAuth } = require('../middleware/auth-middleware');
const receiptStore = require('../receipts/receipt-store');
const claimImport  = require('../claims/claim-import');
const claimQueue   = require('../claims/claim-queue');
const claimWorker  = require('../claims/claim-worker');
const { readParts } = require('../receipts/read-receipt');
const { suggestCategories } = require('../claims/claim-categories');
const { createClaimRecord } = require('../claims/claim-record');
const { undoImport } = require('../claims/claim-undo');
const reports      = require('../store/reports');
const wf           = require('../reports/workflow');
const logger       = require('../utils/logger');

// A batch claim: a zip of receipts plus the claim-form spreadsheet, as they
// arrive by email. Runs as a background job; the client polls.
const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;
// Parsed only on this route, after sign-in; index.js keeps the rest to 100 KB.
const bigJson = express.json({ limit: '25mb' });
// A file name or a label is shown back to the claimant, and becomes a case
// title and a stored receipt's original name: it must be text, and not a page.
const MAX_NAME = 200;

// Every file in the archive is read exactly as an upload of it is
// (receipts/read-receipt.js readParts): a PDF of several receipts becomes
// several records, each knowing its page, and a photo of several receipts laid
// side by side becomes one per receipt, each knowing its region. Photos used to
// go five to a call through the batch reader, which reads one receipt per
// image, so a photo an upload splits in three imported as one.
async function parseEntries(userId, entries) {
  const out = [];
  for (const e of entries) {
    try {
      const read = await readParts(userId, e.buffer, e.mime);
      out.push({ parts: read.parts, notes: read.notes });
    } catch (err) {
      logger.warn('Claim receipt could not be read', { userId, error: err.message });
      out.push(null);
    }
  }
  return out;
}

function deps() {
  return {
    parseReceipts: parseEntries,
    storeReceipt: (uid, id, buffer, mime) => receiptStore.forUser(uid).save(id, buffer, mime),
    createRecord: createClaimRecord,
    suggest: (uid, matches, categories) => suggestCategories(uid, matches, categories),
    // Takes back what an import saved: before it runs again after a restart
    // (it used to make every row twice), and when it is cancelled or fails
    // part-way through saving.
    clearPartial: (uid, importId) => undoImport(uid, importId),
  };
}
claimWorker.registerJobType('claim-import', {
  defaultDeps: () => deps(),
  run: ({ userId, job, payload, deps: d }) => claimImport.startImport({
    userId, archives: payload.archives, forms: payload.forms, label: job.label, id: job.id,
    reportId: job.reportId || null, cancelled: !!job.cancelled,
  }, d),
});

// The queue is shared with other kinds of job; these routes answer for claim
// imports only. A job written before types existed is one.
const isClaim = j => !j.type || j.type === 'claim-import';

// Whether the case an import was started from may take its receipts: the rule
// an upload into a case keeps (routes/receipts.js).
function caseProblem(user, reportId) {
  const r = reports.getReport(reportId);
  if (!r || r.companyId !== user.companyId) return { status: 404, error: 'Case not found' };
  if (r.userId !== user.id) return { status: 403, error: 'That case belongs to someone else' };
  if (!wf.isEditable(r)) return { status: 409, error: `A ${r.status} case cannot take more receipts` };
  return null;
}

const isText = v => v === undefined || v === null || typeof v === 'string';
const clip = v => String(v || '').trim().slice(0, MAX_NAME);

router.post('/import', requireAuth, bigJson, (req, res) => {
  try {
    const { archives = [], forms = [], label, reportId = null } = req.body || {};
    if (!Array.isArray(archives) || !Array.isArray(forms) || (!archives.length && !forms.length)) return res.status(400).json({ error: 'Attach at least a claim archive or a claim form' });
    if (!isText(label)) return res.status(400).json({ error: 'The import label must be text' });
    if (!isText(reportId)) return res.status(400).json({ error: 'The case must be given by its id' });
    if (reportId) {
      const bad = caseProblem(req.user, reportId);
      if (bad) return res.status(bad.status).json({ error: bad.error });
    }
    const decode = list => {
      const out = [];
      for (const f of list) {
        if (!isText(f && f.name)) return { error: 'A file name must be text' };
        const name = clip(f && f.name) || 'a file';
        if (typeof (f && f.data) !== 'string' || !f.data) return { error: `${name} came through empty. Open it once so it downloads, then try again.` };
        const buffer = decodeBase64(f.data);
        if (!buffer) return { error: `${name} arrived damaged and could not be decoded.` };
        out.push({ name: clip(f.name) || 'file', buffer });
      }
      return { out };
    };
    const a = decode(archives); if (a.error) return res.status(400).json({ error: a.error });
    const f = decode(forms);    if (f.error) return res.status(400).json({ error: f.error });
    const bytes = [...a.out, ...f.out].reduce((s, x) => s + x.buffer.length, 0);
    if (bytes > MAX_UPLOAD_BYTES) return res.status(413).json({ error: `That is ${(bytes / 1048576).toFixed(1)}MB; the limit is ${MAX_UPLOAD_BYTES / 1048576}MB.` });

    const enq = claimQueue.enqueue(req.user.id, { archives: a.out, forms: f.out, label: clip(label) || 'Expense claim', reportId: reportId || null });
    if (enq.error) return res.status(429).json({ error: enq.error });
    claimWorker.startWorker(req.user.id, deps());
    claimWorker.kickWorker(req.user.id);
    logger.info('Claim import enqueued', { userId: req.user.id, jobId: enq.job.id, reportId: reportId || null });
    res.status(202).json({ jobId: enq.job.id, stage: enq.job.stage });
  } catch (err) {
    logger.error('Claim import could not start', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: 'The import could not start. Try again.' });
  }
});

const view = j => ({ id: j.id, label: j.label, stage: j.stage, receiptsTotal: j.receiptsTotal, receiptsRead: j.receiptsRead, rowsTotal: j.rowsTotal, error: j.error, result: j.result,
                     startedAt: j.startedAt ? new Date(j.startedAt).toISOString() : (j.createdAt || null) });

router.get('/active', requireAuth, (req, res) => {
  const mem = claimImport.listJobs(req.user.id).find(j => !claimQueue.TERMINAL.has(j.stage));
  if (mem) return res.json({ job: view(mem) });
  const disk = claimQueue.getPending(req.user.id).find(isClaim);
  res.json({ job: disk ? view(disk) : null });
});

// The person's most recent finished import, for as long as it is kept (an
// hour). /active stops answering the moment an import is done, so closing the
// panel lost its reconciliation and its Undo for good. One already undone is
// not offered again.
router.get('/latest', requireAuth, (req, res) => {
  const fresh = j => Date.now() - Date.parse(j.updatedAt || j.createdAt || 0) <= claimQueue.JOB_TTL_MS;
  const job = claimQueue.list(req.user.id)
    .filter(j => isClaim(j) && fresh(j))
    .map(j => claimImport.getJob(j.id, req.user.id) || j)
    .find(j => j.stage === 'done' && !(j.result && j.result.undone));
  res.json({ job: job ? view(job) : null });
});

router.get('/import/:jobId', requireAuth, (req, res) => {
  const job = claimImport.getJob(req.params.jobId, req.user.id) || claimQueue.get(req.user.id, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Import not found — it may have expired' });
  res.json(view(job));
});

// Stopping an import. One running here is stopped by the engine, which takes
// back what it saved and writes how it ended; marking it cancelled on disk as
// well let the engine's next progress write put it back to running. One that
// is only on disk is cancelled there, unless it had already run part-way when
// a restart stopped it: it may hold saved records, so it is marked and left
// for the engine, which takes them back before it settles.
router.delete('/import/:jobId', requireAuth, (req, res) => {
  const uid = req.user.id, id = req.params.jobId;
  let job = claimImport.cancel(id, uid);
  if (!job) {
    const disk = claimQueue.get(uid, id);
    if (disk && isClaim(disk) && !claimQueue.TERMINAL.has(disk.stage) && disk.attempts > 0 && disk.attempts < claimQueue.MAX_ATTEMPTS) {
      job = claimQueue.save(uid, { id, stage: 'cancelling', cancelled: true });
      claimWorker.startWorker(uid, deps());
      claimWorker.kickWorker(uid);
    } else {
      job = claimQueue.markCancelled(uid, id);
    }
  }
  if (!job) return res.status(404).json({ error: 'Import not found' });
  res.json({ stage: job.stage });
});

// Undo a whole import: every expense from it, and every file nothing else uses.
router.delete('/group/:groupId', requireAuth, (req, res) => {
  const uid = req.user.id, groupId = req.params.groupId;
  const out = undoImport(uid, groupId);
  if (!out.found) return res.status(404).json({ error: 'Nothing found for that import' });
  // The import is marked undone, so /latest does not offer its reconciliation
  // and an Undo with nothing left to undo.
  const mem = claimImport.getJob(groupId, uid);
  if (mem && mem.result) mem.result = { ...mem.result, undone: true };
  const disk = claimQueue.get(uid, groupId);
  if (disk && disk.result) claimQueue.save(uid, { id: groupId, result: { ...disk.result, undone: true } });
  logger.info('Claim import undone', { userId: uid, groupId, removed: out.removed, kept: out.kept.length, files: out.files, casesRemoved: out.casesRemoved });
  res.json({
    removed: out.removed,
    kept: out.kept.map(e => ({ id: e.id, merchant: e.merchant, why: 'it is in a case that has been claimed' })),
  });
});

module.exports = router;
