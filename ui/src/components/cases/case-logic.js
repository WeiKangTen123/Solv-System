// The decisions behind the Cases list and the case page that are not drawing:
// how the list's filters live in the address, what a row of the list offers
// to do next, where a case is on its way (Receipts → Check → Claim → Xero) and
// the one thing its owner should do now.
//
// No imports, so main/scripts/ui-case-logic.test.js can load it from source.

export const PAGE_SIZE = 20;

// The chips over the list, in the order they are shown. "Ready to claim" is
// not a status of its own on the server: it is the open cases that pass the
// claim's checks, asked for with ?ready=1.
export const CHIPS = [
  { id: 'open', label: 'Open' },
  { id: 'ready', label: 'Ready to claim' },
  { id: 'claimed', label: 'Claimed' },
  { id: 'draft', label: 'Drafts' },
  { id: 'all', label: 'All' },
];
const CHIP_IDS = CHIPS.map(c => c.id);
const STATUS_CHIPS = ['open', 'claimed', 'draft', 'all'];

export const SORTS = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'amount', label: 'Largest amount' },
  { id: 'dates', label: 'Latest dates' },
];
const SORT_IDS = SORTS.map(s => s.id);
const KIND_IDS = ['trip', 'period', 'case'];

// The list's filters, read from the address (a URLSearchParams). The address
// holds them so Back and Forward step through them and Home can link straight
// to a view: /reports?status=open, /reports?ready=1, /reports?status=draft,
// /reports?scope=all&owner=<id>. Anything it does not know reads as no filter
// rather than an empty list.
//
// `chip` is null when the address names none: which one that means depends on
// the counts (defaultChip).
export function readFilters(params) {
  const get = k => String((params && params.get(k)) || '').trim();
  const status = get('status');
  const chip = get('ready') === '1' ? 'ready' : STATUS_CHIPS.includes(status) ? status : null;
  const scope = get('scope') === 'all' ? 'all' : 'mine';
  const page = parseInt(get('page'), 10);
  return {
    chip,
    kind: KIND_IDS.includes(get('kind')) ? get('kind') : '',
    sort: SORT_IDS.includes(get('sort')) ? get('sort') : 'newest',
    q: get('q'),
    scope,
    owner: scope === 'all' ? get('owner') : '',
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

// With no chip in the address the list opens on Open while the person has an
// open case: that is where the work is, and a year of claimed cases would
// otherwise bury it. With none open, an empty Open would read as "you have no
// cases", so it opens on All. Until the counts are known it is Open, the
// usual answer, so the first request is usually the only one.
export function defaultChip(counts) {
  return counts && Number(counts.open) === 0 ? 'all' : 'open';
}

// GET /reports's query for those filters, one page of PAGE_SIZE.
export function listQuery(f, chip, { canAll = false } = {}) {
  const q = new URLSearchParams();
  if (canAll && f.scope === 'all') {
    q.set('scope', 'all');
    if (f.owner) q.set('owner', f.owner);
  }
  if (chip === 'ready') q.set('ready', '1');
  else if (chip && chip !== 'all') q.set('status', chip);
  if (f.kind) q.set('kind', f.kind);
  if (f.q) q.set('q', f.q);
  if (f.sort && f.sort !== 'newest') q.set('sort', f.sort);
  q.set('limit', String(PAGE_SIZE));
  q.set('offset', String((Math.max(1, f.page || 1) - 1) * PAGE_SIZE));
  return q.toString();
}

// The address after a change of filters. Any change but the page itself goes
// back to page 1: page 3 of another filter is nobody's next page. Defaults are
// left out, so the address stays as short as what was chosen.
export function withFilter(params, patch) {
  const n = new URLSearchParams(params);
  const put = (k, v) => { if (v === undefined) return; if (v === '' || v === null) n.delete(k); else n.set(k, String(v)); };
  if (patch.chip !== undefined) {
    n.delete('status');
    n.delete('ready');
    if (patch.chip === 'ready') n.set('ready', '1');
    else if (CHIP_IDS.includes(patch.chip)) n.set('status', patch.chip);
  }
  put('kind', patch.kind);
  if (patch.sort !== undefined) put('sort', patch.sort === 'newest' ? '' : patch.sort);
  put('q', patch.q === undefined ? undefined : String(patch.q).trim());
  if (patch.scope !== undefined) {
    if (patch.scope === 'all') n.set('scope', 'all');
    else { n.delete('scope'); n.delete('owner'); }
  }
  put('owner', patch.owner);
  if (patch.page !== undefined) put('page', patch.page > 1 ? patch.page : '');
  else n.delete('page');
  n.delete('new');
  return n;
}

// ── A row of the list ───────────────────────────────────────────────────────

// How many of a case's receipts are still being read, and how many are read
// and waiting for the person. `unreviewed` counts everything not checked, the
// ones being read with it.
export function rowFacts(r) {
  const count = Number(r && r.expenseCount) || 0;
  const reading = Number(r && r.reading) || 0;
  const toCheck = Math.max(0, (Number(r && r.unreviewed) || 0) - reading);
  return { count, reading, toCheck };
}

// "2 to check", "3 reading", "1 reading, 2 to check", "all checked", or ''
// for a case with nothing in it.
export function receiptsWords(r) {
  const { count, reading, toCheck } = rowFacts(r);
  if (!count) return '';
  const parts = [reading ? `${reading} reading` : '', toCheck ? `${toCheck} to check` : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : 'all checked';
}

// Where a row goes when it is opened: the owner's draft carries on where it
// was being put together; everything else is the case page (which shows an
// admin someone else's draft as it stands).
export function caseHref(r, meId) {
  if (r.status === 'draft' && r.userId === meId) return `/reports/new?draft=${encodeURIComponent(r.id)}`;
  return `/reports/${encodeURIComponent(r.id)}`;
}

// The one next step a row offers, or null. Only ever for the person's own
// case: an admin looking at everyone's acts on none of them.
//
// A claimed case offers nothing here, not even Post to Xero: whether Xero is
// connected is not in the list (GET /xero is an admin's), and a button that
// leads to "Xero is not connected" is worse than none. The case page says.
export function rowAction(r, meId) {
  if (!r || r.userId !== meId) return null;
  const id = encodeURIComponent(r.id);
  if (r.status === 'draft') return { id: 'continue', label: 'Continue', to: `/reports/new?draft=${id}` };
  if (r.status !== 'open') return null;
  const { count, reading, toCheck } = rowFacts(r);
  if (!count) return { id: 'add', label: 'Add receipts', to: `/reports/${id}` };
  if (toCheck) return { id: 'check', label: `Check ${toCheck}`, to: `/reports/${id}/review` };
  if (reading) return null;
  if (r.ready) return { id: 'claim', label: 'Claim', to: `/reports/${id}` };
  return null;
}

// ── The case page ───────────────────────────────────────────────────────────

// What the case page decides from: counts of its receipts by where they
// stand, and whether it would pass the claim's checks (reports/workflow.js
// markClaimed, the same rule as the list's `ready`).
export function caseFacts(report) {
  const list = (report && report.expenses) || [];
  const t = (report && report.totals) || {};
  const reading = list.filter(e => e.status === 'reading').length;
  const toCheck = list.filter(e => e.status !== 'reviewed' && e.status !== 'reading').length;
  const noRate = Number(t.pendingRates) || 0;
  // A receipt still being read has no lines yet, so the server counts it
  // under noAmount too; it is said as being read instead.
  const noAmount = Math.max(0, (Number(t.noAmount) || 0) - reading);
  const ready = !!report && report.status === 'open' && list.length > 0 && !reading && !toCheck && !noRate && !(Number(t.noAmount) || 0);
  return { count: list.length, reading, toCheck, noRate, noAmount, ready };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Receipts → Check → Claim → Xero, for the Stepper. Each step is done once
// nothing is left in it; the first that is not is the current one.
export function caseSteps(report, { posted = false, xeroConnected = false } = {}) {
  const f = caseFacts(report);
  const claimed = !!report && report.status === 'claimed';
  const steps = [
    { id: 'receipts', label: 'Receipts', done: claimed || (f.count > 0 && !f.reading),
      hint: !f.count ? 'none yet' : f.reading ? `${f.reading} reading` : plural(f.count, 'receipt', 'receipts') },
    { id: 'check', label: 'Check', done: claimed || (f.count > 0 && !f.reading && !f.toCheck),
      hint: f.toCheck ? `${f.toCheck} left` : f.count && !f.reading ? 'all checked' : '' },
    { id: 'claim', label: 'Claim', done: claimed,
      hint: claimed ? 'claimed' : f.ready ? 'ready' : f.count && !f.reading && !f.toCheck && (f.noRate || f.noAmount) ? 'not priced yet' : '' },
    { id: 'xero', label: 'Xero', done: !!posted,
      hint: posted ? 'posted' : claimed && !xeroConnected ? 'not connected' : '' },
  ];
  let current = false;
  return steps.map(s => {
    let state = s.done ? 'done' : 'todo';
    if (!s.done && !current) { state = 'current'; current = true; }
    return { id: s.id, label: s.label, state, hint: s.hint || undefined };
  });
}

// The one button the owner gets for the next step, or null when the next
// step is not theirs to take yet (receipts still being read, a rate still to
// come) or there is none (posted, or Xero is not connected).
//
//   add    open the file picker (an empty case)
//   check  the review page, on the first receipt that needs them
//   claim  ask, then POST /claimed
//   post   the dry run, then ask, then POST /post
export function casePrimary(report, { isOwner = false, posted = false, xeroConnected = false } = {}) {
  if (!report || !isOwner) return null;
  const f = caseFacts(report);
  const id = encodeURIComponent(report.id);
  if (report.status === 'open' || report.status === 'draft') {
    if (!f.count) return { id: 'add', label: 'Add receipts' };
    if (f.toCheck) return { id: 'check', label: `Check ${plural(f.toCheck, 'receipt', 'receipts')}`, to: `/reports/${id}/review` };
    if (f.ready) return { id: 'claim', label: 'Claim this case' };
    return null;
  }
  if (report.status === 'claimed' && !posted && xeroConnected) return { id: 'post', label: 'Post to Xero' };
  return null;
}

// ── The receipts table ──────────────────────────────────────────────────────

// What a receipt's lines are, in one short phrase, under its merchant.
// Listing every line's category verbatim turned a folio split four ways into a
// column of single words 170px tall, which is how the screen came to look
// unfinished.
export function summarise(lines = []) {
  if (!lines.length) return '—';
  const cats = [...new Set(lines.map(l => l.category).filter(Boolean))];
  const shown = cats.slice(0, 2).join(', ') + (cats.length > 2 ? ` +${cats.length - 2}` : '');
  const behalf = lines.some(l => l.onBehalfOf) ? ' ‡' : '';
  // The reader does not always land a category, and a receipt checked in a
  // hurry can carry none at all. Without this the cell read "4 lines · " with
  // a separator pointing at nothing, or was simply empty for a single line.
  const what = shown || 'Uncategorised';
  if (lines.length === 1) return what + behalf;
  return `${lines.length} lines · ${what}${behalf}`;
}

// The ‡ above used to be the person's name inline — Lodging (Henry Bennett).
// The dagger is shorter, but a mark nothing explains is worse than a long
// column, so whoever it stands for is named once under the table.
export function onBehalfNames(expenses = []) {
  return [...new Set(expenses.flatMap(e => (e.lines || []).map(l => l.onBehalfOf).filter(Boolean)))];
}

// Where a receipt stands, for the table's last column: 'checked', 'reading',
// 'duplicate', or 'check' (read, waiting for the person).
export function receiptState(e) {
  if (!e) return 'check';
  if (e.status === 'reviewed') return 'checked';
  if (e.status === 'reading') return 'reading';
  if (e.status === 'duplicate') return 'duplicate';
  return 'check';
}
