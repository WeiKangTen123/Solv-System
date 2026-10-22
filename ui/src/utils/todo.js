// What is waiting on a person, and where each thing is opened: the decisions
// behind Home's to-do links and case cards and My receipts' rows. Kept in one
// place so the two pages cannot send the same receipt to different screens,
// or count "to check" two ways.
//
// No imports, so main/scripts/ui-todo.test.js can load it from source. The
// one function that prints a date takes the formatter as an argument.

// A case is opened on its own page, except a draft, which is still being put
// together on the New case page (its own page would only redirect there).
export function casePath(id, status) {
  return status === 'draft' ? `/reports/new?draft=${encodeURIComponent(id)}` : `/reports/${id}`;
}

// A receipt in a case is checked in that case's review, where the next one is
// a key press away; one outside any case has only its own page. Rows from GET
// /expenses carry their case's status as `reportStatus`.
export function receiptPath(e) {
  if (!e || !e.reportId) return `/expenses/${e && e.id}`;
  if (e.reportStatus === 'draft') return casePath(e.reportId, 'draft');
  return `/reports/${e.reportId}/review?receipt=${encodeURIComponent(e.id)}`;
}

// A read that left nothing to check: the reader failed, was stopped, or never
// reached the AI (receipts/read-queue.js hands the row to its owner with a
// note and every field empty). A receipt the reader got even a date off was
// read, however badly, and is simply "to check".
export function readFailed(e) {
  return !!e && e.status === 'review-needed' && !e.merchant && !(Number(e.total) > 0) && !e.receiptDate;
}

// Receipts in a case waiting for the person. The list's `unreviewed` counts
// every receipt not yet checked, those still being read included, and those
// cannot be checked until the reader is done with them.
export function toCheck(r) {
  return Math.max(0, (Number(r && r.unreviewed) || 0) - (Number(r && r.reading) || 0));
}

// The one thing to do next on an open case, as the Cases list says it:
// check what is waiting, wait for the reader, or claim. A case with nothing
// to check that still cannot be claimed is waiting on an amount or a rate,
// which its own page explains. `to` is null while there is nothing to press.
export function nextStep(r) {
  const n = toCheck(r);
  if (!Number(r.expenseCount)) return { kind: 'add', label: 'Add receipts', to: `/reports/${r.id}` };
  if (n) return { kind: 'check', label: `Check ${n}`, to: `/reports/${r.id}/review` };
  if (Number(r.reading)) return { kind: 'reading', label: 'Reading…', to: null };
  if (r.ready) return { kind: 'claim', label: 'Claim', to: `/reports/${r.id}` };
  return { kind: 'open', label: 'Open', to: `/reports/${r.id}` };
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Home's to-do links, in the order they are worth doing, none when its count
// is nought. A link to a single thing goes straight to it rather than to a
// list holding one row. `cases` are the person's drafts and open cases (GET
// /reports?status=draft,open); `failed` the receipts whose read failed.
export function todoLinks({ cases = [], failed = [] } = {}) {
  const open = cases.filter(r => r.status === 'open');
  const drafts = cases.filter(r => r.status === 'draft');
  const checking = open.filter(r => toCheck(r) > 0);
  const nCheck = checking.reduce((s, r) => s + toCheck(r), 0);
  const ready = open.filter(r => r.ready);
  return [
    nCheck > 0 && { id: 'check', tone: 'warning', label: `${nCheck} to check`,
      to: checking.length === 1 ? `/reports/${checking[0].id}/review` : '/reports?status=open' },
    failed.length > 0 && { id: 'failed', tone: 'danger', label: count(failed.length, 'read failed', 'reads failed'),
      to: failed.length === 1 ? receiptPath(failed[0]) : '/expenses?show=failed' },
    drafts.length > 0 && { id: 'draft', tone: 'neutral', label: count(drafts.length, 'draft', 'drafts'),
      to: drafts.length === 1 ? casePath(drafts[0].id, 'draft') : '/reports?status=draft' },
    ready.length > 0 && { id: 'ready', tone: 'success', label: `${ready.length} ready to claim`,
      to: ready.length === 1 ? `/reports/${ready[0].id}` : '/reports?ready=1' },
  ].filter(Boolean);
}

// What a receipt is called in a list: its merchant, or until one is read,
// the name of the file it came from ("IMG_2231.HEIC"), which the person
// recognises where "no merchant" says nothing.
export function receiptName(e) {
  if (!e) return 'a receipt';
  if (e.merchant) return e.merchant;
  if (e.status === 'reading') return 'Reading the receipt…';
  return (e.receipt && e.receipt.originalName) || 'No merchant yet';
}

// How a receipt is named in a sentence: "Grab, 2 Sep", or what it is when it
// has no merchant yet. `fmtDay` is utils/format.js's.
export function receiptLabel(e, fmtDay) {
  if (!e) return 'a receipt';
  const name = e.merchant || (e.status === 'reading' ? 'a receipt still being read'
    : (e.receipt && e.receipt.originalName) || 'a receipt with no merchant');
  return e.receiptDate && fmtDay ? `${name}, ${fmtDay(e.receiptDate)}` : name;
}

// The server's refusals for a batch (POST /reports/:id/expenses answers
// `skipped: [{ id, why }]`), named by receipt: "Grab, 2 Sep (a duplicate);
// Ola, 6 Sep (already in another case)". `rows` are the receipts that were
// sent, to name them by.
export function skippedText(skipped, rows, fmtDay) {
  const byId = new Map((rows || []).map(e => [e.id, e]));
  return (skipped || []).map(s => `${receiptLabel(byId.get(s.id), fmtDay)} (${s.why})`).join('; ');
}
