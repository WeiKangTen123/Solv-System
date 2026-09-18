const express      = require('express');
const router       = express.Router();
const { decodeBase64 } = require('../utils/base64');
const { requireAuth } = require('../middleware/auth-middleware');
const store        = require('../store/expenses');
const receiptStore = require('../receipts/receipt-store');
const claimImport  = require('../claims/claim-import');
const claimQueue   = require('../claims/claim-queue');
const claimWorker  = require('../claims/claim-worker');
const { parseReceiptBatch } = require('../receipts/receipt-parser');
const { readOne }  = require('../receipts/read-receipt');
const { suggestCategories } = require('../claims/claim-categories');
const { createClaimRecord } = require('../claims/claim-record');
const logger       = require('../utils/logger');

// A batch claim: a zip of receipts plus the claim-form spreadsheet, as they
// arrive by email. Runs as a background job; the client polls.
const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;

// Images are read five to a call; a PDF in the archive goes through the same
// classify-and-read the upload path uses (text, or rendered pages).
async function parseEntries(userId, entries) {
  const out = new Array(entries.length).fill(null);
  const imageIdx = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].mime === 'application/pdf') { try { out[i] = await readOne(userId, entries[i].buffer, entries[i].mime); } catch { out[i] = null; } }
    else imageIdx.push(i);
  }
  if (imageIdx.length) {
    const read = await parseReceiptBatch(userId, imageIdx.map(i => ({ buffer: entries[i].buffer, mime: entries[i].mime })));
    imageIdx.forEach((i, k) => { out[i] = read[k]; });
  }
  return out;
}

function deps() {
  return {
    parseReceipts: parseEntries,
    storeReceipt: (uid, id, buffer, mime) => receiptStore.forUser(uid).save(id, buffer, mime),
    createRecord: createClaimRecord,
    suggest: (uid, matches, categories) => suggestCategories(uid, matches, categories),
  };
}
claimWorker.registerJobType('claim-import', {
  defaultDeps: () => deps(),
  run: ({ userId, job, payload, deps: d }) => claimImport.startImport({ userId, archives: payload.archives, forms: payload.forms, label: job.label, id: job.id }, d),
});

router.post('/import', requireAuth, (req, res) => {
  try {
    const { archives = [], forms = [], label } = req.body || {};
    if (!Array.isArray(archives) || !Array.isArray(forms) || (!archives.length && !forms.length)) return res.status(400).json({ error: 'Attach at least a claim archive or a claim form' });
    const decode = list => {
      const out = [];
      for (const f of list) {
        const name = (f && f.name) || 'a file';
        if (typeof (f && f.data) !== 'string' || !f.data) return { error: `${name} came through empty. Open it once so it downloads, then try again.` };
        const buffer = decodeBase64(f.data);
        if (!buffer) return { error: `${name} arrived damaged and could not be decoded.` };
        out.push({ name: f.name || 'file', buffer });
      }
      return { out };
    };
    const a = decode(archives); if (a.error) return res.status(400).json({ error: a.error });
    const f = decode(forms);    if (f.error) return res.status(400).json({ error: f.error });
    const bytes = [...a.out, ...f.out].reduce((s, x) => s + x.buffer.length, 0);
    if (bytes > MAX_UPLOAD_BYTES) return res.status(413).json({ error: `That is ${(bytes / 1048576).toFixed(1)}MB; the limit is ${MAX_UPLOAD_BYTES / 1048576}MB.` });

    const enq = claimQueue.enqueue(req.user.id, { archives: a.out, forms: f.out, label: label || 'Expense claim' });
    if (enq.error) return res.status(429).json({ error: enq.error });
    claimWorker.startWorker(req.user.id, deps());
    claimWorker.kickWorker(req.user.id);
    logger.info('Claim import enqueued', { userId: req.user.id, jobId: enq.job.id });
    res.status(202).json({ jobId: enq.job.id, stage: enq.job.stage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const view = j => ({ id: j.id, label: j.label, stage: j.stage, receiptsTotal: j.receiptsTotal, receiptsRead: j.receiptsRead, rowsTotal: j.rowsTotal, error: j.error, result: j.result,
                     startedAt: j.startedAt ? new Date(j.startedAt).toISOString() : (j.createdAt || null) });

router.get('/active', requireAuth, (req, res) => {
  const mem = claimImport.listJobs(req.user.id).find(j => !['done', 'failed', 'cancelled'].includes(j.stage));
  if (mem) return res.json({ job: view(mem) });
  const disk = claimQueue.getPending(req.user.id)[0];
  res.json({ job: disk ? view(disk) : null });
});

router.get('/import/:jobId', requireAuth, (req, res) => {
  const job = claimImport.getJob(req.params.jobId, req.user.id) || claimQueue.get(req.user.id, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Import not found — it may have expired' });
  res.json(view(job));
});

router.delete('/import/:jobId', requireAuth, (req, res) => {
  const mem = claimImport.cancel(req.params.jobId, req.user.id);
  const disk = claimQueue.markCancelled(req.user.id, req.params.jobId);
  if (!mem && !disk) return res.status(404).json({ error: 'Import not found' });
  res.json({ stage: (mem && mem.stage) || (disk && disk.stage) || 'cancelled' });
});

// Undo a whole import: every expense from it, and every file nothing else uses.
router.delete('/group/:groupId', requireAuth, (req, res) => {
  const members = store.listExpenses({ groupId: req.params.groupId, userId: req.user.id });
  if (!members.length) return res.status(404).json({ error: 'Nothing found for that import' });
  let files = 0;
  for (const e of members) {
    store.deleteExpense(e.id);
    if (e.receipt && store.countExpensesForReceipt(e.receipt.id) === 0) {
      if (store.countExpensesForFile(e.receipt.userId, e.receipt.file) === 0 && receiptStore.forUser(e.receipt.userId).remove(e.receipt.file)) files++;
      store.deleteReceipt(e.receipt.id);
    }
  }
  logger.info('Claim import undone', { userId: req.user.id, groupId: req.params.groupId, removed: members.length, files });
  res.json({ removed: members.length });
});

module.exports = router;
