// The case PDF, laid out for pdfmake. Nothing here renders a byte
// (reports/expense-export.js does); this is the document as plain data.
//
//   1  Cover            who, what, the amount, and what is inside
//   2  Summary          totals by category and by currency, the rates, tax,
//                       the claimant's declaration, a box for finance
//   3  Expense details  every line, with the receipt that backs it
//   4  Allowances, items to note, activity   (each only when it has something)
//   5  Receipts         one per page, in the case's order, each saying which
//                       lines it is for
//
// A4 portrait: a receipt is a tall thing, and on a landscape page a hotel folio
// printed at a quarter of the page. The totals are expense-doc's buildModel,
// the same numbers the CSV and the workbook carry, so the three cannot disagree.
const doc = require('./expense-doc');
const { runs, plain } = require('./pdf-text');
const { declarationFor, currentClaim, DECLARED_NOTE } = require('./declaration');
const { localDate } = require('../utils/zone-date');
const { SOURCE_LONG, SOURCE_VIA } = require('../fx/sources');
const { fmtRate, fmtDate, fmtStamp, POLICY_LABEL } = doc;

const money = n => require('../utils/money').formatAmount(n);
const cents = n => Math.round(Number(n || 0) * 100);

const C = {
  accent: '#0F6E56', accentSoft: '#E7F2EE', ink: '#111827', body: '#1F2937', muted: '#6B7280', faint: '#9CA3AF',
  rule: '#DADDD5', band: '#F4F5F1', track: '#ECEEE8', warn: '#9A5B00', warnSoft: '#FDF3DC', red: '#B42318', redSoft: '#FDECEA',
};
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = [40, 72, 40, 52];
const WIDTH = PAGE.width - MARGIN[0] - MARGIN[2];
// The tallest a receipt image may be: what is left of the page under its
// caption. An image taller than the space left is pushed to the next page by
// itself and leaves its caption alone on this one.
const IMAGE_FIRST = 600, IMAGE_MORE = 665;

const ALLOWANCE = new Set(['per_diem', 'mileage']);
const DATES_LABEL = { trip: 'Trip', period: 'Period', case: 'Dates' };
// The words the case page uses for its history (ui CaseActivity.jsx).
const SAID = { created: 'Created', opened: 'Created from a draft', claimed: 'Marked claimed', reopened: 'Reopened', edited: 'Edited', checked: 'Checked', posted: 'Posted to Xero', xero_failed: 'Posting to Xero failed' };
const TAX_NAME = { SGD: 'GST', MYR: 'SST' };

// Text from people and receipts, as runs pdfmake can draw (pdf-text.js).
const R = v => { const r = runs(v); return Array.isArray(r) ? r : [r]; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// "4 – 8 Oct 2026", "28 Sep – 3 Oct 2026", "30 Dec 2026 – 2 Jan 2027".
function fmtSpan(from, to) {
  if (!from && !to) return null;
  if (!from || !to || from === to) return fmtDate(from || to);
  if (!ISO.test(from) || !ISO.test(to)) return `${fmtDate(from)} – ${fmtDate(to)}`;
  const [fy, fm] = from.split('-'), [ty, tm] = to.split('-');
  const start = fmtDate(from).split(' ');
  if (fy === ty && fm === tm) return `${start[0]} – ${fmtDate(to)}`;
  if (fy === ty) return `${start[0]} ${start[1]} – ${fmtDate(to)}`;
  return `${fmtDate(from)} – ${fmtDate(to)}`;
}
// "Lines 3, 9–11": runs of consecutive numbers joined.
function fmtNumbers(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b), parts = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i + 1 ? `${s[i]}–${s[j]}` : j === i + 1 ? `${s[i]}, ${s[j]}` : `${s[i]}`);
    i = j;
  }
  return parts.join(', ');
}
const linesWord = nums => `${new Set(nums).size === 1 ? 'Line' : 'Lines'} ${fmtNumbers(nums)}`;
const safeImage = uri => (typeof uri === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(uri) ? uri : null);
// A PNG's width over its height, read from its header; null for anything else.
function pngAspect(uri) {
  if (!/^data:image\/png;base64,/.test(uri || '')) return null;
  const head = Buffer.from(uri.slice(uri.indexOf(',') + 1, uri.indexOf(',') + 1 + 44), 'base64');
  if (head.length < 24 || head.toString('latin1', 12, 16) !== 'IHDR') return null;
  const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
  return w > 0 && h > 0 ? w / h : null;
}

// ── The numbers ─────────────────────────────────────────────────────────────
function pdfModel(payload) {
  const { company = {}, report, owner = {}, lines = [], receipts = [], flags = {} } = payload;
  const base = company.baseCurrency || 'SGD';
  const tz = company.timezone || 'Asia/Singapore';
  const m = doc.buildModel(payload);

  const rows = lines.map((l, i) => {
    const allowance = ALLOWANCE.has(l.source);
    const pending = l.baseAmount === null || l.baseAmount === undefined;
    const description = l.description && l.description !== l.merchant ? l.description : null;
    return {
      n: i + 1, ref: l.ref || null, key: l.expenseId || (l.ref ? `ref:${l.ref}` : `line:${i + 1}`), allowance,
      date: l.date, merchant: l.merchant || 'No merchant', description, purpose: l.purpose || null, onBehalfOf: l.onBehalfOf || null,
      category: l.category || 'Other', currency: l.currency || base, amount: Number(l.amount) || 0,
      rate: l.fxRate, foreign: (l.currency || base) !== base, pending, base: pending ? null : Number(l.baseAmount),
      tax: Number(l.tax) || 0, baseTax: Number(l.baseTax) || 0, line: l,
    };
  });

  // Each receipt's lines, so a flag and a caption can name them.
  const byKey = new Map();
  for (const r of rows) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r); }
  // One entry per receipt, with everything flagged on it: a receipt over its
  // limit and dated on a Sunday is one thing to look at, said twice.
  const notes = [];
  for (const [key, rs] of byKey) {
    const list = [...(flags[key] || [])];
    if (!rs[0].ref && !rs[0].allowance) list.push({ level: 'yellow', code: 'no-receipt', text: 'No receipt is attached.' });
    if (!list.length) continue;
    const red = list.filter(f => f.level === 'red');
    notes.push({ level: red.length ? 'red' : 'yellow', lines: rs.map(r => r.n), ref: rs[0].ref, merchant: rs[0].merchant,
      texts: [...red, ...list.filter(f => f.level !== 'red')].map(f => ({ text: f.text, red: f.level === 'red' })) });
  }
  notes.sort((a, b) => (a.level === b.level ? a.lines[0] - b.lines[0] : a.level === 'red' ? -1 : 1));
  const flagged = new Set(notes.flatMap(n => n.lines));

  // By category in the company's own order and grouping (Settings, "Categories
  // on the PDF's summary"): a category it does not list is counted under Other,
  // as the workbook and the old printed columns did. buildModel decides it, so
  // the summary cannot disagree with the other exports.
  const counts = {};
  for (const r of m.rows) if (!r.pending) counts[r.column] = (counts[r.column] || 0) + 1;
  const totalCents = cents(m.total);
  const categories = m.columns.filter(c => counts[c]).map(c => {
    const c100 = cents(m.categoryTotals[c]);
    return { name: c, lines: counts[c], amount: c100 / 100, share: totalCents ? c100 / totalCents : 0 };
  });

  const cur = new Map();
  for (const r of rows) {
    const c = cur.get(r.currency) || { code: r.currency, cents: 0, baseCents: 0, rates: new Set(), pending: 0 };
    c.cents += cents(r.amount);
    if (r.pending) c.pending++; else c.baseCents += cents(r.base);
    if (r.foreign && Number(r.rate) > 0) c.rates.add(Number(r.rate));
    cur.set(r.currency, c);
  }
  const currencies = [...cur.values()].sort((a, b) => (a.code === base ? -1 : b.code === base ? 1 : b.baseCents - a.baseCents))
    .map(c => ({ code: c.code, amount: c.cents / 100, base: c.baseCents / 100, pending: c.pending, rates: [...c.rates].sort((a, b) => a - b) }));

  return { m, rows, notes, flagged, categories, currencies, rateNotes: rateNotes(rows, base, company), base, tz,
    tax: taxTotals(rows, base), allowances: rows.filter(r => r.allowance), receipts, company, report, owner };
}

// One note per currency and source: a week of ringgit receipts priced at the
// central bank's daily rate is one source, said once with its dates. The
// old footnote said it once per day, five near-identical lines for one trip.
function rateNotes(rows, base, company) {
  const groups = new Map(), manual = [], out = [];
  for (const r of rows) {
    const l = r.line;
    if (!r.foreign || !(Number(l.fxRate) > 0)) continue;
    if (l.fxSource === 'manual') { manual.push(r); continue; }
    const key = `${r.currency}|${l.fxSource}`;
    const g = groups.get(key) || { currency: r.currency, source: l.fxSource, rates: new Set(), dates: [] };
    g.rates.add(Number(l.fxRate)); if (l.fxRateDate) g.dates.push(l.fxRateDate);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const rates = [...g.rates].sort((a, b) => a - b);
    const dates = g.dates.sort();
    const rate = rates.length === 1 ? fmtRate(rates[0]) : `${fmtRate(rates[0])} to ${fmtRate(rates.at(-1))}`;
    const when = dates.length ? ` for ${fmtSpan(dates[0], dates.at(-1))}` : '';
    out.push(`${g.currency} to ${base} ${rate}: ${SOURCE_LONG[g.source] || g.source}${when}, via ${SOURCE_VIA[g.source] || g.source}.`);
  }
  for (const r of manual) {
    const l = r.line;
    out.push(`Line ${r.n}: ${r.currency} to ${base} ${fmtRate(l.fxRate)}, entered by ${l.fxOverrideBy || 'finance'} on ${fmtDate(l.fxRateDate)}${l.fxOverrideReason ? `: ${l.fxOverrideReason}` : ''}.`);
  }
  const late = [...new Set(rows.filter(r => r.line.fxNotOnTheDay).map(r => r.currency))];
  if (late.length) out.push(`${late.join(' and ')} ${late.length === 1 ? 'has' : 'have'} no published rate for the receipt date; those lines use the rate on the day the case was priced.`);
  if (out.length) out.push(`Rates follow the company's policy: ${POLICY_LABEL[company.fxPolicy] || POLICY_LABEL.receipt_date}. Each line is converted and rounded to the cent; the total is the sum of the lines.`);
  return out;
}

// The tax printed on the receipts, in the base currency: the local tax a
// company may be able to reclaim, and foreign tax, which it cannot.
function taxTotals(rows, base) {
  const local = rows.filter(r => !r.foreign && !r.allowance).reduce((s, r) => s + cents(r.tax), 0) / 100;
  const foreign = rows.filter(r => r.foreign && !r.pending).reduce((s, r) => s + cents(r.baseTax), 0) / 100;
  return { local, foreign, name: TAX_NAME[base] || 'Tax' };
}

// ── Building blocks ─────────────────────────────────────────────────────────
const noBorders = (pad = [0, 0, 0, 0]) => ({ hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => pad[0], paddingTop: () => pad[1], paddingRight: () => pad[2], paddingBottom: () => pad[3] });
const box = (stack, fill, pad = 12) => ({ table: { widths: ['*'], body: [[{ stack, fillColor: fill }]] }, layout: noBorders([pad, pad - 2, pad, pad - 2]) });
const heading = (id, title, extra = {}) => ({ stack: [
  { text: title, id, style: 'h1' },
  { canvas: [{ type: 'line', x1: 0, y1: 2, x2: 26, y2: 2, lineWidth: 2, lineColor: C.accent }] },
], margin: [0, 0, 0, 10], ...extra });
const subheading = title => ({ text: title.toUpperCase(), style: 'h2', margin: [0, 13, 0, 5] });
const gridLayout = {
  hLineWidth: (i, node) => (i === 0 ? 0 : i === 1 || i === node.table.body.length ? 0.8 : 0.4),
  hLineColor: (i) => (i === 1 ? C.accent : C.rule), vLineWidth: () => 0,
  fillColor: (i) => (i === 0 ? C.band : null),
  paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 2.6, paddingBottom: () => 2.6,
};
const head = (labels, rightFrom) => labels.map((t, i) => ({ text: t, style: 'colHead', alignment: i >= rightFrom ? 'right' : 'left' }));

function statusOf(report, tz) {
  const day = iso => fmtDate(localDate(tz, new Date(iso)));
  if (report.status === 'claimed') {
    const posted = [...(report.events || [])].reverse().find(e => e.action === 'posted');
    return { word: 'Claimed', when: report.claimedAt ? day(report.claimedAt) : null, xero: report.xeroInvoiceId ? (posted ? `In Xero since ${day(posted.at)}` : 'In Xero') : null, open: false };
  }
  return { word: 'Open', when: 'not yet claimed', xero: null, open: true };
}

// ── The pages ───────────────────────────────────────────────────────────────
function coverPage(x, st, sections) {
  const { company, report, owner, m, rows, notes, currencies, receipts, base } = x;
  const logo = safeImage(company.logo);
  const title = report.title || report.purpose || 'Expense claim';
  const subtitle = report.purpose && report.purpose !== title ? report.purpose : null;
  const who = owner.name || owner.email || '—';

  const details = [['Claimant', [...R(who), ...(owner.name && owner.email ? [{ text: `   ${owner.email}`, color: C.muted, fontSize: 8.5 }] : [])]]];
  if (owner.employeeId || owner.department) details.push(['Employee', R([owner.employeeId, owner.department].filter(Boolean).join(' · '))]);
  const span = fmtSpan(report.periodFrom, report.periodTo);
  if (span) details.push([DATES_LABEL[report.kind] || 'Dates', `${span}${report.nights ? ` · ${plural(report.nights, 'night')}` : ''}`]);
  if (report.destination) details.push(['Destination', R(report.destination)]);

  const owed = m.reimbursement < 0;
  const pending = rows.filter(r => r.pending).length;
  const facts = [plural(rows.length, 'line'), plural(receipts.length, 'receipt'), plural(currencies.length, 'currency', 'currencies')];
  if (notes.length) facts.push(`${plural(notes.length, 'item')} to note`);

  const pill = box([
    { text: st.word.toUpperCase(), bold: true, fontSize: 9, color: st.open ? C.warn : C.accent, characterSpacing: 1, alignment: 'center' },
    ...(st.when ? [{ text: st.when, fontSize: 8, color: st.open ? C.warn : C.accent, alignment: 'center', margin: [0, 1, 0, 0] }] : []),
    ...(st.xero ? [{ text: st.xero, fontSize: 7.5, color: C.muted, alignment: 'center', margin: [0, 2, 0, 0] }] : []),
  ], st.open ? C.warnSoft : C.accentSoft, 10);

  return [
    ...(logo ? [{ image: 'logo', fit: [170, 46], margin: [0, 0, 0, 6] }] : []),
    { text: R(company.name || 'Company'), style: logo ? 'coverOrgSmall' : 'coverOrg' },
    { columns: [
      { width: '*', stack: [
        { text: 'EXPENSE CLAIM', style: 'eyebrow' },
        { text: R(title), style: 'coverTitle' },
        ...(subtitle ? [{ text: R(subtitle), style: 'coverSub' }] : []),
        { text: report.number || '', style: 'coverNumber' },
      ] },
      { width: 132, stack: [pill], margin: [12, 18, 0, 0] },
    ], margin: [0, logo ? 40 : 56, 0, 0] },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: WIDTH, y2: 0, lineWidth: 0.6, lineColor: C.rule }], margin: [0, 16, 0, 10] },
    { table: { widths: [84, '*'], body: details.map(([k, v]) => [{ text: k, style: 'label', margin: [0, 2, 0, 0] }, { text: v, style: 'value' }]) }, layout: noBorders([0, 2, 0, 2]) },
    { ...box([
      { text: owed ? 'OWED BACK TO THE COMPANY' : m.reimbursement === 0 ? 'NOTHING TO REIMBURSE' : 'AMOUNT TO REIMBURSE', style: 'eyebrow', color: owed ? C.warn : C.accent },
      { text: `${base} ${money(Math.abs(m.reimbursement))}`, fontSize: 26, bold: true, color: owed ? C.warn : C.ink, margin: [0, 2, 0, 4] },
      { text: facts.join('  ·  '), fontSize: 8.5, color: C.muted },
      ...(m.advances ? [{ text: `Expenses ${base} ${money(m.total)}, less ${base} ${money(m.advances)} advanced.`, fontSize: 8.5, color: C.muted, margin: [0, 2, 0, 0] }] : []),
      ...(pending ? [{ text: `${plural(pending, 'line')} ${pending === 1 ? 'has' : 'have'} no exchange rate yet and ${pending === 1 ? 'is' : 'are'} not in this amount.`, fontSize: 8.5, color: C.warn, margin: [0, 3, 0, 0] }] : []),
    ], owed ? C.warnSoft : C.accentSoft, 14), margin: [0, 16, 0, 0] },
    { text: 'CONTENTS', style: 'eyebrow', margin: [0, 22, 0, 2] },
    // pdfmake lays a page number out as "00000" before it knows it: the column
    // is wide enough for that, or the number wraps.
    { table: { widths: ['*', 40], body: sections.map(s => [
      { text: s.title, linkToDestination: s.id, style: 'toc' },
      { pageReference: s.id, style: 'toc', alignment: 'right' },
    ]) }, layout: { ...noBorders([0, 4, 0, 4]), hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.5), hLineColor: () => C.rule, hLineStyle: () => ({ dash: { length: 1, space: 2 } }) } },
  ];
}

function summaryPage(x, st) {
  const { company, report, owner, m, rows, categories, currencies, tax, base, tz } = x;
  const out = [heading('sec-summary', 'Summary', { pageBreak: 'before' })];
  const priced = rows.filter(r => !r.pending).length;
  const owed = m.reimbursement < 0;
  const totals = [[{ text: `Expenses (${plural(priced, 'line')})`, style: 'value' }, { text: `${base} ${money(m.total)}`, style: 'value', alignment: 'right' }]];
  if (m.advances) totals.push([{ text: 'Less advance received', style: 'value' }, { text: `– ${base} ${money(m.advances)}`, style: 'value', alignment: 'right' }]);
  totals.push([{ text: owed ? 'Owed back to the company' : 'Amount to reimburse', style: 'totalLabel' }, { text: `${base} ${money(Math.abs(m.reimbursement))}`, style: 'totalAmount', alignment: 'right' }]);
  out.push({ table: { widths: ['*', 'auto'], body: totals }, layout: { ...noBorders([0, 3, 0, 3]), hLineWidth: (i, node) => (i === node.table.body.length - 1 ? 1 : 0), hLineColor: () => C.ink } });

  if (report.notes) out.push(subheading('Note from the claimant'), { text: R(report.notes), style: 'body' });

  if (categories.length) {
    const BAR = 170;
    out.push(subheading('By category'), { table: { headerRows: 1, widths: [118, '*', 34, 72, 34], body: [
      head(['Category', '', 'Lines', base, '%'], 2),
      ...categories.map(c => [
        { text: R(c.name), style: 'cell' },
        { canvas: [{ type: 'rect', x: 0, y: 2.5, w: BAR, h: 7, color: C.track }, { type: 'rect', x: 0, y: 2.5, w: Math.max(1.5, BAR * c.share), h: 7, color: C.accent }] },
        { text: String(c.lines), style: 'cell', alignment: 'right' },
        { text: money(c.amount), style: 'cell', alignment: 'right' },
        { text: `${Math.round(c.share * 100)}`, style: 'cell', alignment: 'right' },
      ]),
      [{ text: 'Total', style: 'cellStrong' }, '', { text: String(priced), style: 'cellStrong', alignment: 'right' }, { text: money(m.total), style: 'cellStrong', alignment: 'right' }, ''],
    ] }, layout: gridLayout });
  }

  out.push(subheading('By currency'), { table: { headerRows: 1, widths: [60, '*', '*', 80], body: [
    head(['Currency', 'Spent', 'Rate', base], 1),
    ...currencies.map(c => [
      { text: c.code, style: 'cell' },
      { text: money(c.amount), style: 'cell', alignment: 'right' },
      { text: c.code === base ? '—' : c.rates.length ? c.rates.map(fmtRate).filter((v, i, a) => i === 0 || i === a.length - 1).join(' to ') : 'pending', style: 'cell', alignment: 'right', color: c.code !== base && !c.rates.length ? C.warn : undefined },
      { text: c.pending ? `${money(c.base)} + ${c.pending} pending` : money(c.base), style: 'cell', alignment: 'right' },
    ]),
  ] }, layout: gridLayout });
  x.rateNotes.forEach((t, i) => out.push({ text: R(t), style: 'note', margin: [0, i ? 1 : 4, 0, 0] }));
  if (!x.rateNotes.length && currencies.every(c => c.code === base)) out.push({ text: `Every line is in ${base}; no exchange rate was needed.`, style: 'note', margin: [0, 3, 0, 0] });

  if (tax.local || tax.foreign) {
    const parts = [];
    if (tax.local) parts.push([`${tax.name} on ${base} receipts`, `${base} ${money(tax.local)}`]);
    if (tax.foreign) parts.push([`Tax on receipts in other currencies${base === 'SGD' ? ' (not Singapore input tax)' : ''}`, `${base} ${money(tax.foreign)}`]);
    out.push(subheading('Tax shown on the receipts'), { table: { widths: ['*', 'auto'], body: parts.map(([k, v]) => [{ text: k, style: 'body' }, { text: v, style: 'body', alignment: 'right' }]) }, layout: noBorders([0, 1, 0, 1]) },
      { text: 'Included in the amounts above, as printed on each receipt.', style: 'note', margin: [0, 1, 0, 0] });
  }

  // The declaration: said as made only when the claim window showed it.
  const claim = currentClaim(report.events || []);
  const who = owner.name || owner.email || 'the claimant';
  let said;
  if (report.status !== 'claimed') said = { text: 'Not claimed yet. The claimant makes this declaration in Solv when marking the case claimed.', color: C.warn };
  else if (claim && claim.note === DECLARED_NOTE) said = { text: R(`Declared in Solv by ${claim.actorName || who} when marking the case claimed, ${fmtStamp(claim.at, tz)}.`), color: C.accent, bold: true };
  else said = { text: R(`Marked claimed in Solv by ${who} on ${fmtStamp(report.claimedAt, tz)}, before Solv asked for this declaration.`), color: C.muted };
  out.push({ stack: [subheading('Declaration'), box([
    { text: R(declarationFor(company.name)), style: 'body' },
    { ...said, fontSize: 8.5, margin: [0, 5, 0, 0] },
  ], C.band, 10)], unbreakable: true });

  const sign = label => ({ stack: [
    { canvas: [{ type: 'line', x1: 0, y1: 18, x2: 150, y2: 18, lineWidth: 0.6, lineColor: C.muted }] },
    { text: label, style: 'label', margin: [0, 3, 0, 0] },
  ] });
  out.push({ stack: [subheading('For finance use'), box([
    { text: st.xero ? `${st.xero}${report.xeroInvoiceId ? ` · bill ${String(report.xeroInvoiceId).slice(0, 8)}` : ''}.` : 'Not posted to Xero from Solv.', style: 'value' },
    { columns: [sign('Checked by'), sign('Paid on'), sign('Payment reference')], columnGap: 14, margin: [0, 2, 0, 0] },
  ], C.band, 10)], unbreakable: true });
  return out;
}

function detailsPage(x) {
  const { rows, flagged, m, base } = x;
  const body = [head(['#', 'Date', 'Rcpt', 'Merchant', 'Category', 'Amount', 'Rate', base], 5)];
  for (const r of rows) {
    const what = [r.description, r.purpose].filter(Boolean).join(' — ');
    body.push([
      { text: [String(r.n), ...(flagged.has(r.n) ? [{ text: ' !', bold: true, color: C.warn }] : [])], id: `line-${r.n}`, style: 'cell' },
      { text: fmtDate(r.date), style: 'cell' },
      r.ref ? { text: r.ref, linkToDestination: `receipt-${r.ref}`, style: 'cell', color: C.accent, bold: true }
        : { text: r.allowance ? '—' : 'none', style: 'cell', color: r.allowance ? C.faint : C.warn },
      { stack: [
        { text: R(r.merchant), style: 'cellStrong' },
        ...(what ? [{ text: R(what), style: 'cellSub' }] : []),
        ...(r.allowance ? [{ text: 'Allowance, at the company\'s rates', style: 'cellSub', color: C.accent }] : []),
        ...(r.onBehalfOf ? [{ text: R(`Paid for ${r.onBehalfOf}`), style: 'cellSub' }] : []),
      ] },
      { text: R(r.category), style: 'cell' },
      { stack: [
        { text: `${r.currency} ${money(r.amount)}`, style: 'cell', alignment: 'right' },
        ...(r.tax > 0 ? [{ text: `tax ${money(r.tax)}`, style: 'cellSub', alignment: 'right' }] : []),
      ] },
      { text: r.foreign && Number(r.rate) > 0 ? fmtRate(r.rate) : '', style: 'cell', alignment: 'right' },
      r.pending ? { text: 'rate pending', style: 'cell', color: C.warn, alignment: 'right' } : { text: money(r.base), style: 'cellStrong', alignment: 'right' },
    ]);
  }
  body.push([{ text: `Total ${base}`, style: 'cellStrong', colSpan: 7, alignment: 'right' }, {}, {}, {}, {}, {}, {}, { text: money(m.total), style: 'cellStrong', alignment: 'right' }]);
  return [
    heading('sec-details', 'Expense details', { pageBreak: 'before' }),
    { table: { headerRows: 1, dontBreakRows: true, widths: [20, 48, 24, '*', 66, 72, 40, 56], body }, layout: {
      ...gridLayout,
      hLineWidth: (i, node) => (i === 0 ? 0 : i === 1 ? 0.8 : i === node.table.body.length - 1 || i === node.table.body.length ? 0.8 : 0.4),
      hLineColor: (i, node) => (i === 1 ? C.accent : i === node.table.body.length - 1 ? C.ink : C.rule),
    } },
    ...(() => {
      const says = [rows.some(r => r.ref) ? 'Click a receipt number to see the receipt.' : null, flagged.size ? '! marks a line listed under Items to note.' : null].filter(Boolean);
      return says.length ? [{ text: says.join(' '), style: 'note', margin: [0, 6, 0, 0] }] : [];
    })(),
  ];
}

function morePages(x) {
  const { allowances, notes, report, base, tz } = x;
  const events = report.events || [];
  const out = [];
  const first = () => (out.length ? {} : { pageBreak: 'before' });
  if (allowances.length) {
    out.push(heading('sec-allowances', 'Allowances', first()),
      { text: 'Per diem and mileage are paid at the company\'s own rates, so they have no receipt.', style: 'note', margin: [0, 0, 0, 6] },
      { table: { headerRows: 1, dontBreakRows: true, widths: [16, 60, '*', 72, 56], body: [
        head(['#', 'Type', 'How it was worked out', 'Amount', base], 3),
        ...allowances.map(r => [
          { text: String(r.n), style: 'cell' }, { text: R(r.merchant), style: 'cellStrong' },
          { stack: [{ text: R(r.description || '—'), style: 'cell' }, ...(r.purpose ? [{ text: R(r.purpose), style: 'cellSub' }] : [])] },
          { text: `${r.currency} ${money(r.amount)}`, style: 'cell', alignment: 'right' },
          r.pending ? { text: 'rate pending', style: 'cell', color: C.warn, alignment: 'right' } : { text: money(r.base), style: 'cellStrong', alignment: 'right' },
        ]),
      ] }, layout: gridLayout });
  }
  if (notes.length) {
    const red = notes.some(n => n.level === 'red');
    out.push(heading('sec-notes', 'Items to note', { ...first(), ...(out.length ? { margin: [0, 22, 0, 14] } : {}) }),
      { text: red ? 'Solv flagged these for a second look. The ones marked Must fix stop the case from being claimed.' : 'Solv flagged these for a second look. None of them stops a claim.', style: 'note', margin: [0, 0, 0, 6] },
      { table: { headerRows: 1, dontBreakRows: true, widths: [58, 52, 24, '*'], body: [
        head(['', 'Lines', 'Rcpt', 'What']),
        ...notes.map(n => [
          { text: n.level === 'red' ? 'Must fix' : 'Have a look', style: 'cellStrong', color: n.level === 'red' ? C.red : C.warn },
          { text: linesWord(n.lines), style: 'cell' },
          n.ref ? { text: n.ref, linkToDestination: `receipt-${n.ref}`, style: 'cell', color: C.accent, bold: true } : { text: '—', style: 'cell', color: C.faint },
          { stack: [{ text: R(n.merchant), style: 'cellStrong' }, ...n.texts.map(t => ({ text: R(t.text), style: 'cell', color: t.red ? C.red : undefined }))] },
        ]),
      ] }, layout: gridLayout });
  }
  if (events.length) {
    out.push(heading('sec-activity', 'Activity', { ...first(), ...(out.length ? { margin: [0, 22, 0, 14] } : {}) }),
      { table: { headerRows: 1, dontBreakRows: true, widths: [92, 120, '*'], body: [
        head(['When', 'Who', 'What']),
        ...events.map(e => [
          { text: fmtStamp(e.at, tz), style: 'cell' },
          { text: R(e.actorName || '—'), style: 'cell' },
          { text: R(`${SAID[e.action] || e.action}${e.note ? `: ${e.note}` : ''}`), style: 'cell' },
        ]),
      ] }, layout: gridLayout });
  }
  return out;
}

// One receipt's pages: a caption saying what it is and which lines it backs,
// then its pictures. `first` is the first thing on its page already (after the
// "Receipts" mark, or at the top of a file of receipts), so it breaks no page.
function receiptNodes(x, rc, { first = false } = {}) {
  const { rows, base } = x;
  const out = [];
  {
    const mine = rows.filter(r => r.ref === rc.ref);
    const nums = mine.map(r => r.n);
    const spent = new Map();
    for (const r of mine) spent.set(r.currency, (spent.get(r.currency) || 0) + cents(r.amount));
    const baseCents = mine.filter(r => !r.pending).reduce((s, r) => s + cents(r.base), 0);
    const amount = [...spent].map(([c, v]) => `${c} ${money(v / 100)}`).join(' + ');
    const foreign = [...spent.keys()].some(c => c !== base);
    const facts = [rc.date || mine[0]?.date ? fmtDate(rc.date || mine[0].date) : null, amount ? `${amount}${foreign && mine.every(r => !r.pending) ? ` = ${base} ${money(baseCents / 100)}` : ''}` : null].filter(Boolean).join('  ·  ');
    const cats = [...new Set(mine.map(r => r.category))].join(', ');
    const pages = rc.pages || [];
    out.push({ ...box([{ columns: [
      { width: '*', stack: [
        { text: [{ text: `${rc.ref}   `, color: C.accent }, ...R(rc.title || 'Receipt')], id: `receipt-${rc.ref}`, style: 'capTitle' },
        ...(facts ? [{ text: facts, style: 'capSub' }] : []),
        ...(nums.length ? [{ text: R(`For ${linesWord(nums).toLowerCase()}${cats ? ` · ${cats}` : ''}`), style: 'capSub' }] : []),
      ] },
      { width: 'auto', stack: [
        ...(pages.length > 1 ? [{ text: `page 1 of ${pages.length}`, style: 'capSub', alignment: 'right' }] : []),
        ...(nums.length ? [{ text: 'Back to the lines', linkToDestination: `line-${nums[0]}`, style: 'capLink', alignment: 'right' }] : []),
      ] },
    ] }], C.band, 10), ...(first ? {} : { pageBreak: 'before' }), margin: [0, 0, 0, 10] });
    if (!pages.length) out.push({ text: 'No image could be made of this receipt. The original file is in Solv.', style: 'note' });
    pages.forEach((p, k) => {
      const image = safeImage(p.dataUri);
      if (k > 0) out.push({ text: [{ text: `${rc.ref}   `, color: C.accent, bold: true }, ...R(rc.title || 'Receipt'), { text: `   page ${k + 1} of ${pages.length}`, color: C.muted }], style: 'capSmall', pageBreak: 'before', margin: [0, 0, 0, 8] });
      out.push(image ? { image, fit: [WIDTH, k === 0 ? IMAGE_FIRST : IMAGE_MORE], alignment: 'center' } : { text: 'This page could not be shown.', style: 'note' });
    });
  }
  return out;
}

// ── The document ────────────────────────────────────────────────────────────
// The document in parts, for the export and for Xero (xero/attachments.js,
// which cuts a long case into several files between receipts):
//   frame(cover)      page setup, header, footer and styles; with cover false,
//                     every page carries the header, for a file of receipts only
//   front             the cover, summary, details and the rest
//   receiptsStart     the "Receipts" mark the contents points at
//   receiptNodes(r)   one receipt's pages
function caseParts(payload) {
  const x = pdfModel(payload);
  const { company, report, owner, receipts, tz } = x;
  const st = statusOf(report, tz);
  const generated = fmtStamp(new Date(payload.generatedAt || Date.now()).toISOString(), tz);
  const logo = safeImage(company.logo);
  const who = owner.name || owner.email || '';

  const sections = [{ id: 'sec-summary', title: 'Summary' }, { id: 'sec-details', title: 'Expense details' }];
  if (x.allowances.length) sections.push({ id: 'sec-allowances', title: 'Allowances' });
  if (x.notes.length) sections.push({ id: 'sec-notes', title: 'Items to note' });
  if ((report.events || []).length) sections.push({ id: 'sec-activity', title: 'Activity' });
  if (receipts.length) sections.push({ id: 'sec-receipts', title: receipts.length === 1 ? 'Receipt R1' : `Receipts ${receipts[0].ref} – ${receipts.at(-1).ref}` });

  const header = () => ({ margin: [MARGIN[0], 26, MARGIN[2], 0], stack: [
    { columns: [
      ...(logo ? [{ image: 'logo', fit: [90, 18], width: Math.min(90, Math.round(18 * (pngAspect(logo) || 4))), margin: [0, 0, 10, 0] }] : []),
      { width: '*', text: R(company.name || 'Company'), style: 'hOrg', margin: [0, logo ? 3 : 0, 0, 0] },
      { width: 'auto', text: [{ text: report.number || '', bold: true, color: C.ink }, { text: '   ' }, ...R(who), { text: `   ${st.word}`, color: st.open ? C.warn : C.accent, bold: true }], style: 'hRight', margin: [0, logo ? 3 : 0, 0, 0] },
    ] },
    { canvas: [{ type: 'line', x1: 0, y1: 8, x2: WIDTH, y2: 8, lineWidth: 0.5, lineColor: C.rule }] },
  ] });
  const pageFoot = (page, pages) => ({ margin: [MARGIN[0], 18, MARGIN[2], 0], columns: [
    { text: `Generated ${generated}`, style: 'foot' },
    { text: `Page ${page} of ${pages}`, style: 'foot', alignment: 'right' },
  ] });
  const coverFoot = () => ({ margin: [MARGIN[0], 10, MARGIN[2], 0], text: `Generated from Solv on ${generated}. It shows the case as it was at that moment.`, style: 'foot' });

  const frame = (cover = true) => ({
    pageSize: 'A4', pageOrientation: 'portrait', pageMargins: MARGIN,
    // By name, so it is embedded once: given as a data URI on every page's
    // header, it went into the file once per page.
    images: logo ? { logo } : {},
    info: { title: plain(`${report.number} Expense claim`), author: plain(who), subject: plain(report.title || report.purpose || ''), creator: 'Solv Expenses', producer: 'Solv Expenses' },
    defaultStyle: { font: 'NotoSans', fontSize: 9, color: C.body, lineHeight: 1.15 },
    background: page => (cover && page === 1 ? { canvas: [{ type: 'rect', x: 0, y: 0, w: PAGE.width, h: 8, color: C.accent }] } : null),
    header: page => (cover && page === 1 ? null : header()),
    footer: (page, pages) => (cover && page === 1 ? coverFoot() : pageFoot(page, pages)),
    styles: STYLES,
  });
  return {
    frame,
    front: [...coverPage(x, st, sections), ...summaryPage(x, st), ...detailsPage(x), ...morePages(x)],
    receiptsStart: { text: 'RECEIPTS', id: 'sec-receipts', style: 'eyebrow', pageBreak: 'before', margin: [0, 0, 0, 6] },
    receiptNodes: (rc, opts) => receiptNodes(x, rc, opts),
    receipts,
  };
}

function expenseReportDoc(payload) {
  const p = caseParts(payload);
  const content = [...p.front];
  if (p.receipts.length) content.push(p.receiptsStart);
  p.receipts.forEach((r, i) => content.push(...p.receiptNodes(r, { first: i === 0 })));
  return { ...p.frame(true), content };
}

const STYLES = {
  coverOrg: { fontSize: 15, bold: true, color: C.accent }, coverOrgSmall: { fontSize: 10, bold: true, color: C.ink },
  eyebrow: { fontSize: 7.5, bold: true, color: C.accent, characterSpacing: 1.4 },
  coverTitle: { fontSize: 22, bold: true, color: C.ink, lineHeight: 1.1, margin: [0, 6, 0, 0] },
  coverSub: { fontSize: 11, color: C.body, margin: [0, 4, 0, 0] },
  coverNumber: { fontSize: 11, color: C.muted, margin: [0, 8, 0, 0], characterSpacing: 0.5 },
  label: { fontSize: 7.5, bold: true, color: C.muted, characterSpacing: 0.6 }, value: { fontSize: 10, color: C.ink },
  toc: { fontSize: 10, color: C.ink },
  h1: { fontSize: 15, bold: true, color: C.ink }, h2: { fontSize: 7.5, bold: true, color: C.muted, characterSpacing: 1.2 },
  body: { fontSize: 9, color: C.body, lineHeight: 1.3 }, note: { fontSize: 7.5, color: C.muted, lineHeight: 1.3 },
  totalLabel: { fontSize: 11, bold: true, color: C.ink }, totalAmount: { fontSize: 13, bold: true, color: C.ink },
  colHead: { fontSize: 7, bold: true, color: C.muted, characterSpacing: 0.4 },
  cell: { fontSize: 8 }, cellStrong: { fontSize: 8, bold: true, color: C.ink }, cellSub: { fontSize: 7, color: C.muted },
  capTitle: { fontSize: 12, bold: true, color: C.ink }, capSub: { fontSize: 8, color: C.muted, margin: [0, 2, 0, 0] },
  capLink: { fontSize: 8, bold: true, color: C.accent, margin: [0, 2, 0, 0] }, capSmall: { fontSize: 9, bold: true, color: C.ink },
  hOrg: { fontSize: 9, bold: true, color: C.accent }, hRight: { fontSize: 8, color: C.muted },
  foot: { fontSize: 7, color: C.faint },
};

module.exports = { expenseReportDoc, caseParts, pdfModel, _fmtSpan: fmtSpan, _fmtNumbers: fmtNumbers };
