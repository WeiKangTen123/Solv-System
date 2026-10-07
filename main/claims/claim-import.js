const crypto = require('crypto');
const logger = require('../utils/logger');
const { readArchive, MAX_RECEIPTS } = require('./claim-archive');
const { parseClaimForm } = require('./claim-form');
const { matchClaims }    = require('./claim-matcher');
const { TERMINAL, JOB_TTL_MS } = require('./claim-queue');
const reports = require('../store/reports');
const users   = require('../store/users');
const wf      = require('../reports/workflow');

// Importing a batch claim: unzip, read the form, read every receipt, match.
//
// This runs as a BACKGROUND JOB, not inside a request. Twenty-seven receipts at
// roughly a second and a half each, throttled to stay inside the per-minute
// model quota, is two to three minutes — far past any HTTP timeout, and closing
// the tab must not kill it.
//
// Nothing here writes to Xero. The output is local records for a person to
// review, plus a reconciliation showing which lines need their attention.

// No pacing here. llm/gemini-client.js already holds every caller to the
// quota (a 15-a-minute sliding window per user), and a second, blind sleep
// on top of it only made a large claim take four seconds longer per read.
// Kept as a knob (deps.waitMs) so a test can still slow the loop down.
const READ_INTERVAL_MS = 0;
// How many receipts go to parseReceipts at a time, which is now only how often
// progress is reported and a cancel is noticed. Each file is read on its own,
// exactly as an upload of it is (routes/claims.js): the batch reader, five
// images to a call, returns one receipt per image, so a photo of three
// receipts that an upload splits into three imported as one. One at a time,
// and the bar moves with every receipt.
const BATCH_SIZE = 1;

// Stands in for a receipt the reader returned nothing for.
const BLANK = Object.freeze({ merchant: null, date: null, time: null, category: null, total: null, currency: null, description: null });

const _jobs = new Map();   // jobId -> job
// jobId -> a function called on every state change. This is how the durable
// queue mirrors progress to disk without the engine knowing a disk exists —
// kept out of the job object itself so nothing here has to think about what is
// safe to serialise.
const _hooks = new Map();

// Kept as long as the queue keeps a finished job on disk (claim-queue.js).
function _sweep() {
  const now = Date.now();
  for (const [id, job] of _jobs) if (now - job.updatedAt > JOB_TTL_MS) _jobs.delete(id);
}

function getJob(jobId, userId) {
  _sweep();
  const job = _jobs.get(jobId);
  // A job belongs to the user who started it and nobody else.
  if (!job || job.userId !== String(userId)) return null;
  return job;
}

function listJobs(userId) {
  _sweep();
  return [..._jobs.values()].filter(j => j.userId === String(userId)).sort((a, b) => b.startedAt - a.startedAt);
}

function _notify(job) {
  const hook = _hooks.get(job.id);
  if (!hook) return;
  // A failing mirror must never take the import down with it.
  try { hook(job); } catch (err) { logger.warn('Claim import progress not persisted', { jobId: job.id, error: err.message }); }
}

function _update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  _notify(job);
  return job;
}

// Stages exist so the UI can say WHICH part is slow. One bar sitting at 60% for
// two minutes looks stuck; "reading receipts 18/27" does not.
function _stage(job, stage, detail = {}) {
  // A job being cancelled says so until it stops, rather than flicking back to
  // whichever stage it passes on the way there.
  job.stage = job.cancelled ? 'cancelling' : stage;
  Object.assign(job, detail);
  job.updatedAt = Date.now();
  _notify(job);
  logger.info('Claim import stage', { jobId: job.id, userId: job.userId, stage: job.stage, ...detail });
}

// Starts an import and returns immediately with the job id.
//
// `deps` is injected so the whole flow can be tested without a model or a
// database: everything slow or stateful arrives through it.
// `id` lets the caller name the job — the durable queue passes the id it already
// wrote to disk so the two halves refer to the same thing.
// A zip is a bundle of receipts that belong to each other: a trip, a job, a
// month of fuel. Leaving them in the loose pile and asking the claimant to find
// them again afterwards is work the import can do itself, so everything that
// arrived together is filed into one case, named after the file it came in —
// or into the case the import was started from, when it was.
//
// A case that cannot be created is logged and shrugged off. The receipts are
// the valuable part of an import, and thirty of them read correctly must not be
// lost because a title was too long or a number ran out.
//
// Returns { id, filed, isNew }: the case, how many went into it, and whether
// the import made it.
function _asCase(job, expenseIds) {
  if (!expenseIds.length) return null;
  try {
    const owner = users.findById(job.userId);
    if (!owner) return null;
    // Checked again here rather than only when the import was queued: the case
    // may have been submitted while the receipts were read, and then they go
    // into a new one instead.
    const started = job.reportId ? reports.getReport(job.reportId) : null;
    const into = started && started.userId === job.userId && wf.isEditable(started) ? started : null;
    const from = String(job.label || '').trim();
    const title = from.replace(/\.(zip|xlsx?|csv|pdf)$/i, '').trim() || 'Imported receipts';
    const c = into || reports.createReport({
      companyId: owner.companyId, userId: job.userId, kind: 'case', title,
      purpose: from ? `Imported from ${from}` : 'Imported receipts',
    });
    // Filing is per receipt: one that will not go in must not cost the import
    // the case, which used to be reported as null while existing and holding
    // half of them.
    let filed = 0;
    for (const id of expenseIds) {
      try { reports.addExpense(c.id, id); filed++; }
      catch (err) { logger.warn('A receipt would not go into the case', { jobId: job.id, caseId: c.id, expenseId: id, error: err.message }); }
    }
    logger.info(into ? 'Import filed into the case it was started from' : 'Import became a case', { jobId: job.id, caseId: c.id, number: c.number, expenses: filed });
    return { id: c.id, filed, isNew: !into };
  } catch (err) {
    logger.warn('Could not turn the import into a case', { jobId: job.id, error: err.message });
    return null;
  }
}

// Takes back everything this import has saved, through the undo the Undo
// button uses (deps.clearPartial). Never throws: what it could not take back
// is logged, and the job still reaches an end.
function _clear(job, { clearPartial }, message) {
  if (!clearPartial) return;
  try {
    const out = clearPartial(job.userId, job.id);
    if (out && (out.removed || out.orphans)) logger.info(message, { jobId: job.id, removed: out.removed, orphans: out.orphans });
  } catch (err) {
    logger.warn('Could not take back what an import saved', { jobId: job.id, error: err.message });
  }
}

// A cancel, honoured. Nothing from a cancelled import is kept: the panel says
// so, and a cancel that landed part-way through saving used to leave half the
// claim behind with no Undo to reach it.
function _stop(job, deps) {
  _clear(job, deps, 'Took back what a cancelled import had saved');
  return _update(job, { stage: 'cancelled' });
}

function startImport({ userId, archives = [], forms = [], label = 'Expense claim', id, reportId = null, cancelled = false }, deps) {
  const job = {
    id: id || crypto.randomBytes(9).toString('hex'),
    userId: String(userId),
    label,
    reportId: reportId || null,
    stage: 'queued',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    receiptsTotal: 0,
    receiptsRead: 0,
    rowsTotal: 0,
    error: null,
    result: null,
    // True when the job was cancelled before a restart stopped it: it runs
    // again only to take back what it had saved.
    cancelled: !!cancelled,
  };
  _jobs.set(job.id, job);
  if (deps.onUpdate) _hooks.set(job.id, deps.onUpdate);

  // Deliberately not awaited: the caller gets an id and polls.
  _run(job, { archives, forms }, deps)
    .catch(err => {
      logger.error('Claim import failed', { jobId: job.id, error: err.message });
      _update(job, { stage: 'failed', error: err.message });
    })
    // onSettle runs after the final _update, so whatever released the slot sees
    // the finished job rather than the one before last.
    .then(() => {
      _hooks.delete(job.id);
      if (deps.onSettle) {
        try { deps.onSettle(job); } catch (err) { logger.warn('Claim import settle hook failed', { jobId: job.id, error: err.message }); }
      }
    });

  return job;
}

async function _run(job, { archives, forms }, deps) {
  const { parseReceipts, suggest, waitMs = READ_INTERVAL_MS, batch = BATCH_SIZE } = deps;
  if (job.cancelled) return _stop(job, deps);

  // ── 1. Unpack ────────────────────────────────────────────────────────────
  _stage(job, 'unpacking');
  const entries = [];
  const skipped = [];
  for (const [index, archive] of archives.entries()) {
    // The limit is the import's, not each archive's: an archive may add only
    // what the ones before it left. Two archives of sixty were 120 receipts
    // with no limit reached.
    const r = await readArchive(archive.buffer, { max: MAX_RECEIPTS - entries.length });
    for (const e of r.entries) entries.push({ ...e, archive: archive.name, archiveIndex: index });
    for (const s of r.skipped) skipped.push({ ...s, archive: archive.name });
    if (r.error) skipped.push({ name: archive.name, reason: r.error });
  }
  // readArchive stops extracting at the limit and records the rest as skipped,
  // so entries.length can never exceed it. Checking that alone meant a
  // 150-receipt archive would import 100 and drop 50 silently — which is the
  // worst outcome available. Refuse the whole import instead.
  if (skipped.some(s => /limit reached/i.test(s.reason || ''))) {
    return _update(job, {
      stage: 'failed',
      error: `This import holds more than ${MAX_RECEIPTS} receipts, which is more than one claim should hold. Split it and import each part.`,
    });
  }
  _stage(job, 'unpacked', { receiptsTotal: entries.length });

  // ── 2. Read the claim form ───────────────────────────────────────────────
  _stage(job, 'reading form');
  let rows = [];
  const categories = new Set();
  const formErrors = [];
  for (const [index, form] of forms.entries()) {
    const parsed = await parseClaimForm(form.buffer);
    if (parsed.error) formErrors.push(`${form.name}: ${parsed.error}`);
    // Every line carries a key of its own, its form's place and its row: two
    // forms both have a row "1".
    rows = rows.concat(parsed.rows.map(r => ({ ...r, form: form.name, key: `${index}:${r.rowNumber}` })));
    for (const c of parsed.categories) categories.add(c);
  }
  _stage(job, 'form read', { rowsTotal: rows.length });

  // ── 3. Read every receipt ────────────────────────────────────────────────
  // The slow phase, and the only one worth a progress bar.
  _stage(job, 'reading receipts');
  const reads = [];
  const batchSize = Math.max(1, batch || 1);

  for (let start = 0; start < entries.length; start += batchSize) {
    if (job.cancelled) return _stop(job, deps);
    const slice = entries.slice(start, start + batchSize);

    let parsed;
    try {
      parsed = await parseReceipts(job.userId, slice.map(e => ({ buffer: e.buffer, mime: e.mime })));
    } catch (err) {
      // A whole batch failing must not lose the receipts in it.
      logger.warn('Claim receipt batch unreadable', { jobId: job.id, size: slice.length, error: err.message });
      parsed = new Array(slice.length).fill(null);
    }

    slice.forEach((e, i) => {
      const r = parsed && parsed[i];
      // A file can hold several receipts — the pages of a PDF, a photo of a
      // few laid side by side. Each part is a read of its own, on its page or
      // region of the one file, and fileKey lets the parts share it. The key
      // carries the archive's place in the upload as well as its name: two
      // archives both called receipts.zip, each holding a.jpg, shared one
      // stored file between two different receipts.
      if (r && Array.isArray(r.parts)) {
        const parts = r.parts.length ? r.parts : [{ r: null, page: null, box: null }];
        const fileKey = `${e.archiveIndex}:${e.archive || ''}/${e.name}`;
        // What the reader said about the file as a whole ("only the first 20
        // of 35 pages were read") goes on its first part, so it is seen.
        const notes = Array.isArray(r.notes) && r.notes.length ? r.notes.join(' ') : null;
        parts.forEach((p, k) => reads.push({ ...(p.r || BLANK), file: e.name, mime: e.mime, buffer: e.buffer, readable: !!p.r,
          page: p.page || null, box: p.box || null, part: k, fileKey, notes: k === 0 ? notes : null }));
        return;
      }
      // A receipt that cannot be read still takes part: it is stored, and it is
      // reported as unreadable rather than silently dropped.
      reads.push({ ...(r || BLANK), file: e.name, mime: e.mime, buffer: e.buffer, readable: !!r });
    });
    _update(job, { receiptsRead: Math.min(start + slice.length, entries.length) });

    // Throttled between BATCHES rather than between receipts — the quota counts
    // requests. Skipped after the last batch.
    if (start + batchSize < entries.length && waitMs) await new Promise(r => setTimeout(r, waitMs));
  }
  const unreadable = reads.filter(r => !r.readable);

  // ── 4. Match ─────────────────────────────────────────────────────────────
  _stage(job, 'matching');
  const matched = matchClaims(rows, reads);

  // ── 5. Suggest the categories the claimant left blank ────────────────────
  // Looked up by the line's key, not its number: two forms both have a row
  // "1", and the suggestion for one was applied to the other ("Taxi to
  // airport" became Meals).
  _stage(job, 'categorising');
  const suggested = new Map();
  if (suggest && categories.size) {
    try { for (const s of (await suggest(job.userId, matched.matches, [...categories])) || []) suggested.set(s.key, s); }
    catch (err) { logger.warn('Category suggestion unavailable', { jobId: job.id, error: err.message }); }
  }

  // ── 6. Create the records ────────────────────────────────────────────────
  // A cancel that arrived while the receipts were read is honoured here, the
  // last point before anything is saved.
  if (job.cancelled) return _stop(job, deps);
  _stage(job, 'saving');
  // A job that ran before and died part-way through saving runs again from
  // the top with the same id: what its last attempt saved goes first.
  _clear(job, deps, 'Cleared a part-saved import before saving it again');
  let saved;
  try {
    saved = await _save(job, matched, suggested, deps);
  } catch (err) {
    // Half an import is worse than none: nobody can tell which half is
    // missing, and Undo is offered only for an import that finished. What was
    // saved is taken back, and the job fails saying so.
    _clear(job, deps, 'Took back an import that failed part-way through saving');
    throw new Error(`Saving stopped part-way, so nothing from this import was kept: ${err.message}`);
  }
  // Cancelled between two records: what was saved before it is taken back.
  if (!saved) return _stop(job, deps);

  // ── 7. What arrived together becomes a case ──────────────────────────────
  const filed = _asCase(job, saved.claimable);

  return _update(job, {
    stage: 'done',
    result: {
      groupId: job.id,
      caseId: filed ? filed.id : null,
      // How many receipts are in that case (duplicates are not), and whether
      // the import made it or it is the case the import was started from.
      inCase: filed ? filed.filed : 0,
      caseIsNew: filed ? filed.isNew : false,
      created: saved.created,
      summary: {
        ...matched.summary,
        total: saved.created.length || matched.summary.total,
        unreadable: unreadable.length,
        skippedFiles: skipped.length,
        // Split on purpose: `duplicates` were marked and need no action,
        // `suspected` are the ones a person still has to settle.
        duplicates: saved.duplicates.length,
        suspectedDuplicates: saved.suspected.length,
      },
      discrepancies: matched.matches.filter(m => m.discrepancy).map(m => ({
        rowNo: m.row.no, form: m.row.form, date: m.row.date, description: m.row.description, ...m.discrepancy,
      })),
      missingReceipts: matched.unmatchedRows.map(r => ({ rowNo: r.no, form: r.form, date: r.date, description: r.description, amount: r.amount })),
      extraReceipts: matched.unmatchedReceipts.map(r => ({ file: r.file, merchant: r.merchant, total: r.total, date: r.date })),
      unreadable: unreadable.map(r => ({ file: r.file })),
      duplicates: saved.duplicates,
      suspectedDuplicates: saved.suspected,
      skipped,
      formErrors,
      categoriesSuggested: suggested.size,
    },
  });
}

// Creates every record. Returns what was made, or null when a cancel arrived
// part-way, and leaves taking back what was saved to the caller.
async function _save(job, matched, suggested, { storeReceipt, createRecord }) {
  const groupId = job.id;
  // Files already stored by this import, so the parts of one file share it.
  const files = new Map();
  const created = [];
  // Duplicates are counted as they are created rather than re-queried, because
  // createRecord is the only place that knows what the store said.
  const duplicates = [];
  const suspected = [];
  // Everything except the duplicates, which is what goes into the case: a
  // duplicate can never be marked reviewed, so one sitting in a case would
  // block the submit for good.
  const claimable = [];
  const note = rec => {
    if (!rec) return;
    created.push(rec.id);
    if (rec.status === 'duplicate') { duplicates.push({ id: rec.id, of: rec.duplicateOf, why: rec.errorMsg }); return; }
    claimable.push(rec.id);
    if (rec.errorMsg && /^Possible duplicate/.test(rec.errorMsg)) suspected.push({ id: rec.id, why: rec.errorMsg });
  };

  // One step per record. A cancel is looked for before each: Stop used to be
  // read only before saving began, so a cancel during it saved everything.
  const steps = [
    ...matched.matches.map(m => () => {
      const suggestion = suggested.get(m.row.key) || null;
      return createRecord({
        userId: job.userId, groupId,
        row: m.row, receipt: m.receipt, match: m,
        category: m.row.category || (suggestion && suggestion.category) || null,
        categorySuggested: !m.row.category && !!suggestion,
        store: storeReceipt, files,
      });
    }),
    // Claim lines with no receipt still become records — they are part of the
    // claim and somebody has to resolve them.
    ...matched.unmatchedRows.map(row => () => createRecord({ userId: job.userId, groupId, row, receipt: null, match: null, category: row.category || null, store: storeReceipt, files })),
    // And a receipt with no claim line becomes one too. This was missing, and it
    // meant the commonest case of all produced NOTHING: a zip of nine receipts
    // with no spreadsheet matched nothing, so nothing was created, and the import
    // reported success having imported zero claims. A claim form is a convenience,
    // not a requirement — the receipts are the claim.
    ...matched.unmatchedReceipts.map(receipt => () => createRecord({
      userId: job.userId, groupId,
      // Synthesised from what the model read, so the record carries the figures
      // it found rather than being blank.
      row: {
        no: null,
        date: receipt.date || null,
        description: receipt.description || receipt.merchant || (receipt.file ? receipt.file.split('/').pop() : null),
        currency: receipt.currency || null,
        amount: receipt.total ?? null,
        category: receipt.category || null,
      },
      receipt, match: null, category: receipt.category || null, store: storeReceipt, files,
    })),
  ];
  for (const step of steps) {
    if (job.cancelled) return null;
    note(await step());
  }
  return { created, duplicates, suspected, claimable };
}

// A job that has ended stays as it ended. Cancelling a failed or cancelled
// import used to bring it back as 'cancelling', which the panel then polled
// for ever.
function cancel(jobId, userId) {
  const job = getJob(jobId, userId);
  if (!job) return null;
  if (TERMINAL.has(job.stage)) return job;
  job.cancelled = true;
  return _update(job, { stage: 'cancelling' });
}

function _reset() { _jobs.clear(); _hooks.clear(); }

module.exports = { startImport, getJob, listJobs, cancel, READ_INTERVAL_MS, BATCH_SIZE, MAX_RECEIPTS, _reset };
