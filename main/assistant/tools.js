const db      = require('../db');
const store   = require('../store/expenses');
const reports = require('../store/reports');
const users   = require('../store/users');
const changes = require('../store/changes');
const edit    = require('../receipts/edit');
const wf      = require('../reports/workflow');
const { canView } = require('../middleware/roles');
const { CATEGORY_NAMES, canonicalCategory } = require('../intake/categories');
const { localDate } = require('../utils/zone-date');
const astore  = require('./store');

// What the assistant can do, as tools the model calls. Every tool runs as the
// person in the conversation and is held to exactly what that person could do
// on the page:
//
//   reading    their own receipts and cases; an admin, the company's.
//   proposing  a change becomes a card the person must Apply. Proposals are
//              checked against the same rules as the page (receipts/edit.js)
//              before the card is made, and again when Apply is pressed.
//
// There is no tool for passwords, accounts, roles, keys, settings, the Xero
// connection, deleting, claiming, reopening or posting. The model cannot ask
// for what is not here.
//
// A tool answers with plain data. A refusal is { error }, which the model
// reads and explains; a tool never throws at the conversation.

const MAX_LIST = 50;
const MAX_PROPOSALS = 25;
const DATE = { type: 'string', description: 'YYYY-MM-DD' };

class ToolError extends Error {}
const no = msg => { throw new ToolError(msg); };

// ── Scope ────────────────────────────────────────────────────────────────────

// Whose records a question is about. Everyone's and somebody else's are for
// an admin; anyone else asking gets told rather than quietly given their own.
function _scope(ctx, { person, everyone } = {}) {
  const a = ctx.actor;
  if (everyone) {
    if (a.role !== 'admin') no('Only an admin can look at other people\'s receipts. This person can see their own.');
    return { companyId: a.companyId };
  }
  if (person && String(person).trim()) {
    const q = String(person).trim().toLowerCase();
    const me = users.findById(a.id);
    if (me && [me.email, me.name].filter(Boolean).some(v => v.toLowerCase() === q)) return { userId: a.id };
    if (a.role !== 'admin') no('Only an admin can look at other people\'s receipts. This person can see their own.');
    const all = users.getAllUsers(a.companyId);
    const exact = all.filter(u => [u.email, u.name].filter(Boolean).some(v => v.toLowerCase() === q));
    const found = exact.length ? exact : all.filter(u => [u.email, u.name].filter(Boolean).some(v => v.toLowerCase().includes(q)));
    if (!found.length) no(`Nobody in the company matches "${person}".`);
    if (found.length > 1) no(`"${person}" matches ${found.length} people: ${found.slice(0, 8).map(u => u.name || u.email).join(', ')}. Ask which one.`);
    return { userId: found[0].id };
  }
  return { userId: a.id };
}

function _who(ctx, userId) {
  if (userId === ctx.actor.id) return 'you';
  if (!ctx.names.has(userId)) { const u = users.findById(userId); ctx.names.set(userId, u ? (u.name || u.email) : 'someone'); }
  return ctx.names.get(userId);
}
function _case(ctx, reportId) {
  if (!reportId) return null;
  if (!ctx.cases.has(reportId)) {
    const r = reports.head(reportId);
    ctx.cases.set(reportId, r ? { id: r.id, number: r.number, title: r.title, status: r.status, inXero: !!r.xeroInvoiceId } : null);
  }
  return ctx.cases.get(reportId);
}
function _receipt(ctx, id) {
  const e = id ? store.getExpense(String(id)) : null;
  if (!e || !canView(ctx.actor, e.userId, e.companyId)) no('No receipt with that id that this person can see.');
  return e;
}
const _category = e => (e.lines.length > 1 ? 'split across lines' : edit.categoryOf(e));

// One line about a receipt, for lists.
function _brief(ctx, e) {
  const c = _case(ctx, e.reportId);
  return {
    id: e.id, merchant: e.merchant || null, date: e.receiptDate || null, currency: e.currency || null, total: e.total,
    [`total_${ctx.base}`]: e.baseTotal, category: _category(e), status: e.status,
    case: c ? c.number : null, claimed: !!e.claimed, ...(e.userId !== ctx.actor.id ? { owner: _who(ctx, e.userId) } : {}),
  };
}

// ── Checks ───────────────────────────────────────────────────────────────────

const _same = edit.sameValue;

// What is wrong with or worth a look on one receipt. Deterministic: the same
// receipt gives the same list, whatever the model makes of it.
// The same merchant, day and amount as another receipt this person can see,
// asked of the database rather than by loading every receipt they have: one
// receipt's check used to read the whole company.
function _twin(ctx, e) {
  if (!e.merchant || !e.receiptDate || !(e.total > 0)) return null;
  // The reader already said so in its note; once is enough.
  if (e.duplicateOf || /Possible duplicate/.test(e.errorMsg || '')) return null;
  const mine = e.userId === ctx.actor.id || ctx.actor.role !== 'admin';
  const row = db.prepare(`SELECT id, user_id, merchant, receipt_date FROM expenses
                          WHERE company_id = ? AND receipt_date = ? AND total_cents = ? AND lower(merchant) = lower(?)
                            AND id != ? AND status != 'duplicate' ${mine ? 'AND user_id = ?' : ''} LIMIT 1`)
    .get(...[e.companyId, e.receiptDate, store.toCents(e.total), e.merchant, e.id, ...(mine ? [e.userId] : [])]);
  return row ? { merchant: row.merchant, receiptDate: row.receipt_date, userId: row.user_id } : null;
}

function _issues(ctx, e) {
  const out = [];
  if (e.status === 'reading') return ['Still being read.'];
  if (e.status === 'duplicate') out.push('Marked as a duplicate of another receipt.');
  const missing = [];
  if (!e.merchant) missing.push('merchant');
  if (!e.receiptDate) missing.push('date');
  if (!e.currency) missing.push('currency');
  if (!(e.total > 0)) missing.push('total');
  if (missing.length) out.push(`Missing: ${missing.join(', ')}.`);
  if (!e.lines.length) out.push('Has no lines, so it cannot be priced or reviewed.');
  else if (!store.linesReconcile(e.lines, store.toCents(e.total))) {
    const sum = e.lines.reduce((s, l) => s + Math.round(l.amount * 100), 0) / 100;
    out.push(`The lines add up to ${sum.toFixed(2)} but the total is ${Number(e.total || 0).toFixed(2)}.`);
  }
  if (e.lines.some(l => !l.category)) out.push('A line has no category.');
  if (e.lines.length && e.baseTotal === null) {
    const why = e.lines.find(l => l.fxCheck);
    out.push(`No ${ctx.base} amount yet${why ? `: ${why.fxCheck}` : ' (no exchange rate)'}.`);
  } else {
    const l = e.lines.find(x => x.fxCheck);
    if (l) out.push(`Exchange rate note: ${l.fxCheck}`);
    if (e.lines.some(x => x.fxNotOnTheDay)) out.push(`The rate is from ${e.lines[0].fxRateDate}, not the receipt date, because none is published for ${e.currency} that day.`);
  }
  if (e.tax !== null && e.tax !== undefined && e.total > 0 && e.tax > e.total) out.push('The tax is more than the total.');
  if (e.receiptDate) {
    const today = localDate(ctx.company.timezone);
    if (e.receiptDate > today) out.push('The date is in the future.');
    const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
    if (e.receiptDate < yearAgo) out.push('The receipt is more than a year old.');
  }
  if (!e.purpose && e.status !== 'duplicate') out.push('No business purpose.');
  if (e.errorMsg) out.push(`Reader's note: ${e.errorMsg}`);
  if (e.aiRead) {
    for (const k of ['merchant', 'receiptDate', 'currency', 'total', 'tax', 'invoiceNo']) {
      const read = e.aiRead[k];
      if (read === null || read === undefined || read === '') continue;
      if (!_same(k, read, e[k])) out.push(`${changes.LABEL[k]} is ${e[k] ?? 'empty'} but the reader read ${read} off the receipt.`);
    }
  }
  if (e.aiConfidence === 'low' && e.status !== 'reviewed') out.push('The reader had low confidence; check it against the picture.');
  // The same merchant, day and amount twice, among receipts this person can see.
  const twin = _twin(ctx, e);
  if (twin) out.push(`Looks like a duplicate of another receipt from ${twin.merchant} on ${twin.receiptDate} for the same amount${twin.userId !== e.userId ? `, claimed by ${_who(ctx, twin.userId)}` : ''}.`);
  return out;
}

// ── Reading tools ────────────────────────────────────────────────────────────

const SCOPE_PROPS = {
  person: { type: 'string', description: 'Admins only: a colleague\'s name or email, to look at their records.' },
  everyone: { type: 'boolean', description: 'Admins only: true to look across everyone in the company.' },
};

const READ = {
  find_receipts: {
    description: 'List receipts, newest first. Without person or everyone, the person\'s own.',
    parameters: { type: 'object', properties: {
      status: { type: 'string', enum: ['reading', 'review-needed', 'reviewed', 'duplicate', 'rejected'] },
      from: DATE, to: DATE,
      merchant: { type: 'string', description: 'Part of the merchant name' },
      caseId: { type: 'string' }, unfiled: { type: 'boolean', description: 'Only receipts not in any case' },
      ...SCOPE_PROPS,
    } },
    run(ctx, a) {
      let list;
      if (a.caseId) {
        // A case answers for itself: whoever may see it may list it.
        const r = reports.head(String(a.caseId));
        if (!r || !canView(ctx.actor, r.userId, r.companyId)) no('No case with that id that this person can see.');
        list = store.listExpenses({ reportId: String(a.caseId), status: a.status, from: a.from, to: a.to });
      } else {
        list = store.listExpenses({ ..._scope(ctx, a), status: a.status, from: a.from, to: a.to, unfiled: !!a.unfiled });
      }
      if (a.merchant) { const q = String(a.merchant).toLowerCase(); list = list.filter(e => String(e.merchant || '').toLowerCase().includes(q)); }
      return { count: list.length, receipts: list.slice(0, MAX_LIST).map(e => _brief(ctx, e)), ...(list.length > MAX_LIST ? { note: `Showing the newest ${MAX_LIST}.` } : {}) };
    },
  },

  get_receipt: {
    description: 'Everything saved about one receipt: fields, lines, exchange rate, case, what the reader first read, and what this person may change.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run(ctx, a) {
      const e = _receipt(ctx, a.id);
      const l0 = e.lines[0];
      const perm = edit.permissions(e, ctx.actor);
      return {
        id: e.id, owner: _who(ctx, e.userId), merchant: e.merchant, date: e.receiptDate, time: e.receiptTime, invoiceNo: e.invoiceNo,
        currency: e.currency, total: e.total, tax: e.tax, subTotal: e.subTotal, [`total_${ctx.base}`]: e.baseTotal,
        category: _category(e), purpose: e.purpose, readerDescription: e.description, readerNote: e.errorMsg,
        status: e.status, readerConfidence: e.aiConfidence, readerRead: e.aiRead || null,
        case: _case(ctx, e.reportId), claimed: !!e.claimed, inXero: perm.posted,
        lines: e.lines.map(l => ({ category: l.category, description: l.description, amount: l.amount, [ctx.base]: l.baseAmount, onBehalfOf: l.onBehalfOf || undefined })),
        exchangeRate: l0 && l0.fxRate && l0.fxSource !== 'base'
          ? { rate: l0.fxRate, date: l0.fxRateDate, source: l0.fxSource, typedBy: l0.fxSource === 'manual' ? l0.fxOverrideBy : undefined, reason: l0.fxOverrideReason || undefined, note: l0.fxCheck || undefined }
          : null,
        file: e.receipt ? { type: e.receipt.mime === 'application/pdf' ? 'pdf' : 'photo', pages: e.receipt.pages || undefined, onePartOfSeveral: !!(e.box || e.page) } : null,
        thisPersonCan: { correctDetails: perm.canEditDetails, fileOrMarkReviewed: perm.canAct },
      };
    },
  },

  check_receipt: {
    description: 'Check one receipt for problems: missing fields, lines that do not add up, no exchange rate, fields that differ from what the reader read, likely duplicates, and so on.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run(ctx, a) {
      const e = _receipt(ctx, a.id);
      const issues = _issues(ctx, e);
      return { receipt: _brief(ctx, e), issues, ok: !issues.length };
    },
  },

  find_problems: {
    description: 'Receipts not yet claimed that need attention, each with what is wrong. Without person or everyone, the person\'s own.',
    parameters: { type: 'object', properties: { ...SCOPE_PROPS } },
    run(ctx, a) {
      const scope = _scope(ctx, a);
      const open = store.listExpenses(scope).filter(e => !e.claimed && e.status !== 'rejected');
      const found = [];
      for (const e of open) {
        const issues = _issues(ctx, e).filter(i => !/^No business purpose/.test(i) || e.status !== 'reviewed');
        if (issues.length) found.push({ receipt: _brief(ctx, e), issues });
      }
      return { looked: open.length, withProblems: found.length, receipts: found.slice(0, 30), ...(found.length > 30 ? { note: 'Showing 30.' } : {}) };
    },
  },

  look_at_receipt: {
    description: 'Look at the receipt\'s picture or PDF and answer a question about what is printed on it, e.g. "what is the total and currency?" or "is there a service charge?". Use it to compare the saved fields with the paper.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' } }, required: ['id', 'question'] },
    async run(ctx, a) {
      const e = _receipt(ctx, a.id);
      if (!e.receipt) no('This receipt has no file to look at.');
      // The same look asked twice in one answer is answered once: each is a
      // vision call with the whole file.
      const q = String(a.question || '').slice(0, 500);
      const k = `${e.id}|${q.trim().toLowerCase()}`;
      if (!ctx.looks.has(k)) ctx.looks.set(k, require('./look').lookAt(ctx.actor.id, e, q, { interactive: true }));
      return { answer: await ctx.looks.get(k) };
    },
  },

  receipt_history: {
    description: 'Who changed what on a receipt since it was read, newest first.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run(ctx, a) {
      const e = _receipt(ctx, a.id);
      const list = changes.list(e.id);
      return { changes: list.slice(0, 30).map(c => ({ field: c.label, from: c.oldValue, to: c.newValue, by: c.actorId === ctx.actor.id ? 'you' : (c.actorName || 'someone'), role: c.actorRole, via: c.via, at: c.at })),
               ...(list.length > 30 ? { note: `${list.length} changes; showing 30.` } : {}) };
    },
  },

  find_cases: {
    description: 'List cases (bundles of receipts claimed together). Without person or everyone, the person\'s own.',
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'claimed'] }, ...SCOPE_PROPS } },
    run(ctx, a) {
      const scope = _scope(ctx, a);
      const list = reports.listReports({ ...scope, status: a.status });
      return { count: list.length, cases: list.slice(0, MAX_LIST).map(r => ({
        id: r.id, number: r.number, title: r.title, status: r.status, receipts: r.expenseCount, [`total_${ctx.base}`]: r.totalBase,
        notReviewed: r.unreviewed, withoutRate: r.pendingRates, claimedAt: r.claimedAt, inXero: !!r.xeroInvoiceId,
        ...(r.userId !== ctx.actor.id ? { owner: r.ownerName || r.ownerEmail } : {}),
      })) };
    },
  },

  get_case: {
    description: 'One case: its cover, totals, receipts and recent history.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run(ctx, a) {
      const r = a.id ? reports.getReport(String(a.id)) : null;
      if (!r || !canView(ctx.actor, r.userId, r.companyId)) no('No case with that id that this person can see.');
      return {
        id: r.id, number: r.number, title: r.title, purpose: r.purpose, kind: r.kind, from: r.periodFrom, to: r.periodTo, destination: r.destination,
        owner: _who(ctx, r.userId), status: r.status, claimedAt: r.claimedAt, inXero: !!r.xeroInvoiceId,
        totals: { [ctx.base]: r.totals.totalBase, advances: r.advances, reimbursement: r.totals.reimbursement, byCategory: r.totals.byCategory, notReviewed: r.totals.unreviewed, withoutRate: r.totals.pendingRates },
        receipts: r.expenses.slice(0, 100).map(e => _brief(ctx, e)),
        recentHistory: r.events.slice(-15).map(ev => ({ action: ev.action, note: ev.note, at: ev.at, by: ev.actorId === ctx.actor.id ? 'you' : ev.actorName })),
      };
    },
  },

  spending_summary: {
    description: `Totals in the base currency, grouped. Duplicates and rejected receipts are left out. Without person or everyone, the person's own.`,
    parameters: { type: 'object', properties: {
      groupBy: { type: 'string', enum: ['category', 'month', 'merchant', 'currency', 'case', 'person'] },
      from: DATE, to: DATE, ...SCOPE_PROPS,
    }, required: ['groupBy'] },
    run(ctx, a) {
      const scope = _scope(ctx, a);
      if (a.groupBy === 'person' && !scope.companyId) no('Grouping by person needs everyone: true, which is for admins.');
      const list = store.listExpenses({ ...scope, from: a.from, to: a.to }).filter(e => !['duplicate', 'rejected', 'reading'].includes(e.status));
      const groups = new Map();
      const add = (key, base, receipt, unpriced, original) => {
        const g = groups.get(key) || { key, [ctx.base]: 0, receipts: new Set(), unpricedLines: 0, original: {} };
        g[ctx.base] += base; g.receipts.add(receipt); g.unpricedLines += unpriced;
        if (original) g.original[original.currency] = (g.original[original.currency] || 0) + original.amount;
        groups.set(key, g);
      };
      let total = 0, unpriced = 0;
      for (const e of list) {
        for (const l of e.lines.length ? e.lines : [{ category: e.category, amount: e.total, baseAmount: null }]) {
          const base = l.baseAmount ?? 0, missing = l.baseAmount === null || l.baseAmount === undefined ? 1 : 0;
          total += base; unpriced += missing;
          const key = a.groupBy === 'category' ? (l.category || 'Uncategorised')
            : a.groupBy === 'month' ? (e.receiptDate || 'no date').slice(0, 7)
            : a.groupBy === 'merchant' ? (e.merchant || 'Unknown')
            : a.groupBy === 'currency' ? (e.currency || 'unknown')
            : a.groupBy === 'case' ? (_case(ctx, e.reportId)?.number || 'not in a case')
            : _who(ctx, e.userId);
          add(key, base, e.id, missing, a.groupBy === 'currency' ? { currency: e.currency || '?', amount: Number(l.amount) || 0 } : null);
        }
      }
      const rows = [...groups.values()].map(g => ({ key: g.key, [ctx.base]: Math.round(g[ctx.base] * 100) / 100, receipts: g.receipts.size,
        ...(g.unpricedLines ? { linesWithoutRate: g.unpricedLines } : {}),
        ...(a.groupBy === 'currency' ? { inCurrency: Object.fromEntries(Object.entries(g.original).map(([k, v]) => [k, Math.round(v * 100) / 100])) } : {}) }))
        .sort((x, y) => (a.groupBy === 'month' ? String(y.key).localeCompare(String(x.key)) : y[ctx.base] - x[ctx.base]));
      return { baseCurrency: ctx.base, receipts: list.length, [`total_${ctx.base}`]: Math.round(total * 100) / 100,
               ...(unpriced ? { linesWithoutRate: unpriced, note: 'Lines without an exchange rate are not in the totals.' } : {}),
               groups: rows.slice(0, 40), ...(rows.length > 40 ? { more: rows.length - 40 } : {}) };
    },
  },

  exchange_rate: {
    description: 'The exchange rate from a currency to the base currency for a date (default today), as the app would price it.',
    parameters: { type: 'object', properties: { currency: { type: 'string', description: 'Three-letter code' }, date: DATE }, required: ['currency'] },
    async run(ctx, a) {
      const cur = String(a.currency || '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur)) no('A currency is a three-letter code like INR.');
      if (cur === ctx.base) return { currency: cur, rate: 1, note: 'That is the base currency.' };
      const today = localDate(ctx.company.timezone);
      const date = a.date && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : today;
      const r = await require('../fx/rates').getRate({ from: cur, to: ctx.base, date, today }).catch(err => ({ error: err.message }));
      if (!r || r.error || !(r.rate > 0)) return { currency: cur, date, error: (r && (r.error || r.blocked)) || 'No rate published for that day.' };
      return { currency: cur, to: ctx.base, askedFor: date, rate: r.rate, rateDate: r.rateDate, source: r.source, ...(r.blocked ? { note: r.blocked } : {}) };
    },
  },

  categories: {
    description: 'The expense categories this company uses.',
    parameters: { type: 'object', properties: {} },
    run() { return { categories: CATEGORY_NAMES }; },
  },
};

// ── Proposing tools ──────────────────────────────────────────────────────────

const money = n => (n === null || n === undefined ? 'empty' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const _label = e => `${e.merchant || 'Untitled receipt'}${e.receiptDate ? `, ${e.receiptDate}` : ''}${e.total ? `, ${e.currency || ''} ${money(e.total)}`.replace(' ,', ',') : ''}`;
const _show = (k, v) => (v === null || v === undefined || v === '' ? 'empty' : ['total', 'tax', 'subTotal'].includes(k) ? money(v) : String(v));

function _propose(ctx, { expense, kind, payload, summary }) {
  if (ctx.proposals.length >= MAX_PROPOSALS) no(`That is more than ${MAX_PROPOSALS} changes in one go. Do the first ${MAX_PROPOSALS}, then ask the person to continue.`);
  const action = astore.addAction({ conversationId: ctx.conversationId, userId: ctx.actor.id, expenseId: expense ? expense.id : null, kind, payload, summary });
  ctx.proposals.push(action);
  return { proposed: true, summary, note: 'A card is now in front of the person. Nothing has changed until they press Apply.' };
}
function _detailsOk(ctx, e) {
  const blocked = edit.detailsBlocked(e, ctx.actor);
  if (blocked) no(blocked.error);
}
function _actOk(ctx, e) {
  const blocked = edit.actionBlocked(e, ctx.actor);
  if (blocked) no(blocked.status === 403 ? 'Only the person whose receipt this is can file it or mark it reviewed.' : blocked.error);
}
const REASON = { type: 'string', description: 'Why, in a short sentence the person will read on the card' };

const PROPOSE = {
  propose_receipt_changes: {
    description: 'Propose corrections to a receipt\'s details. Only include fields that change. The person sees a card and must press Apply.',
    parameters: { type: 'object', properties: {
      id: { type: 'string' },
      changes: { type: 'object', properties: {
        merchant: { type: 'string' }, receiptDate: DATE, receiptTime: { type: 'string', description: 'HH:MM' }, invoiceNo: { type: 'string' },
        currency: { type: 'string' }, total: { type: 'number' }, tax: { type: 'number' }, purpose: { type: 'string', description: 'The business purpose' },
        category: { type: 'string', enum: CATEGORY_NAMES },
      } },
      reason: REASON,
    }, required: ['id', 'changes', 'reason'] },
    run(ctx, a) {
      const e = _receipt(ctx, a.id);
      _detailsOk(ctx, e);
      let patch;
      try { patch = edit.cleanPatch(a.changes && typeof a.changes === 'object' ? a.changes : {}); }
      catch (err) { no(err.message); }
      // A receipt split across lines takes its category from the lines.
      if (patch.category && e.lines.length > 1) no('This receipt is split across lines; change the categories with propose_lines.');
      const from = {};
      for (const k of Object.keys(patch)) {
        if (_same(k, patch[k], e[k]) && k !== 'category') { delete patch[k]; continue; }
        if (k === 'category' && _same(k, patch[k], _category(e))) { delete patch[k]; continue; }
        from[k] = k === 'category' ? _category(e) : (e[k] ?? null);
      }
      if (!Object.keys(patch).length) no('Those are already the values on the receipt.');
      const summary = `${_label(e)}: ${Object.keys(patch).map(k => `${changes.LABEL[k] || k} ${_show(k, from[k])} → ${_show(k, patch[k])}`).join('; ')}`;
      return _propose(ctx, { expense: e, kind: 'edit_details', payload: { expenseId: e.id, patch, from, reason: String(a.reason || '').slice(0, 300) }, summary });
    },
  },

  propose_lines: {
    description: 'Propose a new split of a receipt into lines (one per category, or per colleague paid for). They must add up exactly to the receipt total.',
    parameters: { type: 'object', properties: {
      id: { type: 'string' },
      lines: { type: 'array', items: { type: 'object', properties: {
        category: { type: 'string', enum: CATEGORY_NAMES }, description: { type: 'string' }, amount: { type: 'number' },
        onBehalfOf: { type: 'string', description: 'A colleague this part was paid for, if any' },
      }, required: ['category', 'amount'] } },
      reason: REASON,
    }, required: ['id', 'lines', 'reason'] },
    run(ctx, a) {
      const e = _receipt(ctx, a.id);
      _detailsOk(ctx, e);
      const lines = Array.isArray(a.lines) ? a.lines : [];
      if (!lines.length || lines.length > 50) no('Give between one and fifty lines.');
      const clean = lines.map(l => {
        const amount = Number(l && l.amount);
        if (!(amount > 0) || amount > edit.MAX_AMOUNT) no('Every line needs an amount above zero.');
        const category = canonicalCategory(l.category);
        if (!category) no(`Unknown category "${l.category}". Use one of: ${CATEGORY_NAMES.join(', ')}.`);
        return { category, description: l.description ? String(l.description).slice(0, 250) : null, amount, onBehalfOf: l.onBehalfOf ? String(l.onBehalfOf).trim().slice(0, 80) || null : null };
      });
      const sum = clean.reduce((s, l) => s + Math.round(l.amount * 100), 0);
      if (sum !== store.toCents(e.total)) no(`These lines add up to ${money(sum / 100)} but the receipt total is ${money(e.total)}. They must match to the cent; if the total is wrong, propose that first.`);
      const summary = `${_label(e)}: lines ${changes.linesSummary(e.lines) || 'none'} → ${changes.linesSummary(clean)}`;
      // What the card was made against: Apply refuses if the lines or the
      // total have moved since, rather than overwriting somebody's newer split.
      return _propose(ctx, { expense: e, kind: 'edit_lines', payload: { expenseId: e.id, lines: clean, reason: String(a.reason || '').slice(0, 300), basis: changes.linesSummary(e.lines), total: e.total }, summary });
    },
  },

  propose_exchange_rate: {
    description: 'Propose an exchange rate for a foreign-currency receipt: either a rate the person has (from a card statement, say) with the reason, or refresh: true to fetch the published rate again.',
    parameters: { type: 'object', properties: {
      id: { type: 'string' }, rate: { type: 'number', description: `How much of the base currency one unit of the receipt's currency is worth` },
      refresh: { type: 'boolean' }, reason: REASON,
    }, required: ['id', 'reason'] },
    async run(ctx, a) {
      const e = _receipt(ctx, a.id);
      _detailsOk(ctx, e);
      if (!e.currency || e.currency === ctx.base) no(`This receipt is in ${e.currency || 'no currency yet'}; it needs no exchange rate.`);
      if (!e.lines.length) no('The receipt has no lines yet, so there is nothing to price.');
      if (a.refresh) {
        return _propose(ctx, { expense: e, kind: 'refresh_rate', payload: { expenseId: e.id }, summary: `${_label(e)}: fetch the published ${e.currency} rate again, dropping any typed rate` });
      }
      const rate = Number(a.rate);
      if (!(rate > 0) || !Number.isFinite(rate)) no('Give a rate above zero, or refresh: true.');
      const reason = String(a.reason || '').trim();
      if (!reason) no('A typed rate needs a reason, such as "card statement rate".');
      const problem = await require('../fx/apply').typedRateProblem(e, rate, ctx.actor);
      if (problem) no(problem);
      const now = e.lines[0] && e.lines[0].fxRate;
      // A rate is for one currency: Apply refuses once the receipt's currency
      // has changed. An admin's rate card for INR applied after the receipt
      // became USD turned USD 10,000 into SGD 155.
      return _propose(ctx, { expense: e, kind: 'set_rate', payload: { expenseId: e.id, rate, reason: reason.slice(0, 200), currency: e.currency },
        summary: `${_label(e)}: ${e.currency} rate ${now ? Number(now.toPrecision(6)) : 'none'} → ${Number(rate.toPrecision(6))} (${reason.slice(0, 80)})` });
    },
  },

  propose_mark_reviewed: {
    description: 'Propose marking one of the person\'s own receipts as reviewed, once its details are complete and its lines add up. Not for other people\'s receipts.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run(ctx, a) {
      const e = _receipt(ctx, a.id);
      _actOk(ctx, e);
      if (e.status === 'reviewed') no('It is already reviewed.');
      const why = edit.reviewBlocked(e);
      if (why) no(why);
      return _propose(ctx, { expense: e, kind: 'mark_reviewed', payload: { expenseId: e.id }, summary: `${_label(e)}: mark reviewed` });
    },
  },

  propose_file_in_case: {
    description: 'Propose moving one of the person\'s own receipts into one of their open cases, or out of its case (caseId null).',
    parameters: { type: 'object', properties: { id: { type: 'string' }, caseId: { type: 'string', description: 'The case id; empty to take it out of its case' } }, required: ['id'] },
    run(ctx, a) {
      const e = _receipt(ctx, a.id);
      _actOk(ctx, e);
      if (e.status === 'duplicate') no('A duplicate cannot be filed.');
      const target = a.caseId ? reports.getReport(String(a.caseId)) : null;
      if (a.caseId && (!target || target.userId !== e.userId)) no('That is not one of this person\'s cases.');
      if (target && !wf.isEditable(target)) no(`Case ${target.number} has been claimed; it cannot take more receipts.`);
      if ((target ? target.id : null) === (e.reportId || null)) no('It is already there.');
      const cur = _case(ctx, e.reportId);
      return _propose(ctx, { expense: e, kind: 'file_in_case', payload: { expenseId: e.id, caseId: target ? target.id : null },
        summary: `${_label(e)}: ${target ? `file in ${target.number}${target.title ? ` (${target.title})` : ''}` : `take out of ${cur ? cur.number : 'its case'}`}` });
    },
  },
};

const ALL = { ...READ, ...PROPOSE };
const DEFINITIONS = Object.entries(ALL).map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters } }));

// Runs one tool call. Always answers with data, never throws.
async function run(ctx, name, args) {
  const tool = ALL[name];
  if (!tool) return { error: `There is no tool called ${name}.` };
  try { return await tool.run(ctx, args && typeof args === 'object' ? args : {}); }
  catch (err) {
    if (err instanceof ToolError) return { error: err.message };
    require('../utils/logger').warn('Assistant tool failed', { tool: name, error: err.message });
    return { error: 'That did not work because of a problem on the server. Say so; do not guess the answer.' };
  }
}

function context(actor) {
  const company = users.getCompany(actor.companyId) || { baseCurrency: 'SGD', timezone: 'Asia/Singapore' };
  return { actor, company, base: company.baseCurrency || 'SGD', names: new Map(), cases: new Map(), looks: new Map(), proposals: [], conversationId: null };
}

module.exports = { DEFINITIONS, run, context, READ, PROPOSE, _issues, _scope, MAX_PROPOSALS };
