// Everything about what an expense report LOOKS like, as plain data.
// buildModel() decides rows, columns and notes; expenseReportDoc() lays that
// out for pdfmake; expenseReportCsv() and workbookModel() reuse the model, so
// the three exports cannot disagree. Nothing here renders a byte.
const ACCENT = '#0F6E56', MUTED = '#6b7280', RULE = '#d8dbd4', BAND = '#f3f4ef';
const SOURCE_LABEL = { frankfurter: 'European Central Bank reference rate', 'open.er-api': 'ExchangeRate-API daily rate' };
const VIA = { frankfurter: 'Frankfurter', 'open.er-api': 'open.er-api.com' };
const POLICY_LABEL = { receipt_date: 'rate on the receipt date', submission_date: 'rate on the submission date', monthly_fixed: 'monthly fixed rate table' };

const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// A rate printed to six significant figures. The stored number keeps every
// digit the provider gave — a rupiah rate is 0.0000717308657915501, and the
// conversion needs all of it — but printing that on a report implies a
// precision nobody has. Six is what the provider actually knows.
function fmtRate(r) {
  const n = Number(r);
  if (!Number.isFinite(n) || n === 0) return String(r ?? '');
  const fixed = n.toPrecision(6);
  return fixed.includes('e') ? String(n) : fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
const cents = n => Math.round(Number(n || 0) * 100);
// Month names by hand: ICU writes "Sept" for en-GB, and a report should not
// change its spelling with the Node version it was printed on.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function fmtStamp(iso, tz) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const zone = tz || 'Asia/Singapore';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).formatToParts(d).map(p => [p.type, p.value]));
  const text = `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year} ${parts.hour}:${parts.minute}`;
  return zone === 'Asia/Singapore' ? `${text} SGT` : text;
}
// The standard PDF fonts cover Latin-1 only. Anything else is folded to "?"
// so a name in another script produces a readable placeholder rather than a
// stream that dies mid-page. The en dash, right quote, double dagger and
// arrow are kept: they are drawn by these fonts and the report uses them.
// The arrow is not in the standard font's encoding at all, so it becomes the word.
const latin1 = v => String(v ?? '').replace(/\s*→\s*/g, ' to ').replace(/[^ -ÿ–—‘’‡•]/g, '?');

function buildModel(payload) {
  const { company, report, lines = [] } = payload;
  const base = company.baseCurrency;
  const listed = company.reportColumns || [];
  const colOf = l => (listed.includes(l.category) ? l.category : 'Other');
  const used = new Set(lines.map(colOf));
  const columns = listed.filter(c => used.has(c));
  if (used.has('Other') && !columns.includes('Other')) columns.push('Other');

  const rows = lines.map((l, i) => {
    const col = colOf(l);
    const parts = [l.merchant];
    if (l.description && l.description !== l.merchant) parts.push(l.description);
    let desc = parts.filter(Boolean).join(' · ');
    if (l.purpose) desc += ` — ${l.purpose}`;
    if (l.onBehalfOf) desc += ' ‡';
    return { n: i + 1, ref: l.ref, date: l.date, description: desc, currency: l.currency, amount: l.amount, rate: fmtRate(l.fxRate), base: l.baseAmount, column: col, cells: { [col]: l.baseAmount }, onBehalfOf: l.onBehalfOf || null, foreign: l.currency !== base };
  });
  const categoryCents = {};
  for (const r of rows) categoryCents[r.column] = (categoryCents[r.column] || 0) + cents(r.base);
  const categoryTotals = Object.fromEntries(Object.entries(categoryCents).map(([k, v]) => [k, v / 100]));
  const total = rows.reduce((s, r) => s + cents(r.base), 0) / 100;
  const advances = Number(report.advances || 0);
  const reimbursement = Math.round((total - advances) * 100) / 100;

  const seen = new Set(); const rateNotes = [];
  for (const l of lines) {
    if (l.currency === base || !l.fxRate) continue;
    const key = `${l.currency}|${l.fxRate}|${l.fxRateDate}|${l.fxSource}|${l.fxOverrideBy || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (l.fxSource === 'manual') rateNotes.push(`${l.currency}→${base} ${fmtRate(l.fxRate)} entered by ${l.fxOverrideBy || 'finance'} on ${fmtDate(l.fxRateDate)}${l.fxOverrideReason ? `: ${l.fxOverrideReason}` : ''}.`);
    else rateNotes.push(`${l.currency}→${base} ${fmtRate(l.fxRate)}, ${SOURCE_LABEL[l.fxSource] || l.fxSource} for ${fmtDate(l.fxRateDate)}, via ${VIA[l.fxSource] || l.fxSource}, fetched ${fmtStamp(l.fxFetchedAt, company.timezone)}.`);
  }
  const notes = [];
  if (rateNotes.length) notes.push(`Policy: ${POLICY_LABEL[company.fxPolicy] || POLICY_LABEL.receipt_date}. Each line is converted and rounded to the cent; the total is the sum of the lines.`);
  const behalf = [...new Set(lines.map(l => l.onBehalfOf).filter(Boolean))];
  if (behalf.length) notes.push(`‡ Paid on behalf of ${behalf.join(', ')}; the charge was transferred to the claimant's bill.`);
  // A rate priced after the receipt is not the receipt's rate. It happens for
  // the currencies no central bank publishes daily history for, and a reader of
  // the report should not have to work it out from two dates in a footnote.
  const notOnTheDay = [...new Set(lines.filter(l => l.fxNotOnTheDay).map(l => l.currency))];
  if (notOnTheDay.length) {
    notes.push(`${notOnTheDay.join(' and ')} ${notOnTheDay.length === 1 ? 'has' : 'have'} no published rate for the receipt date; those lines use the rate on the day the report was priced, shown above.`);
  }
  if (lines.some(l => l.currency !== base && l.tax > 0)) notes.push(`Foreign tax (GST/VAT) is included in the amounts and is not ${base === 'SGD' ? 'Singapore' : 'local'} input tax.`);
  return { base, columns, rows, categoryTotals, total, advances, reimbursement, rateNotes, notes };
}

function statusLine(report) {
  if (['approved', 'paid', 'posted'].includes(report.status)) return `Approved ${fmtDate(report.approvedAt)}`;
  return report.status.charAt(0).toUpperCase() + report.status.slice(1);
}

function expenseReportDoc(payload) {
  const { company, report, owner = {}, manager = {}, approver = {}, receipts = [], generatedAt = Date.now() } = payload;
  const m = buildModel(payload);
  const L = latin1;
  const period = report.kind === 'period' ? 'Period' : report.kind === 'case' ? 'Case' : 'Trip';
  const span = `${fmtDate(report.periodFrom)} – ${fmtDate(report.periodTo)}${report.nights ? ` · ${report.nights} night${report.nights === 1 ? '' : 's'}` : ''}`;
  const cover = [
    ['Employee', owner.name || owner.email || '—', 'Purpose', report.purpose || report.title || '—'],
    ['Employee ID', owner.employeeId || '—', period, span],
    ['Department', owner.department || '—',
      report.kind === 'trip' ? 'Destination' : 'Reference',
      report.kind === 'trip' ? (report.destination || '—') : report.number],
    ['Manager', manager.name || '—', 'Status', statusLine(report)],
  ];
  const head = ['#', 'Date', 'Description', 'Ccy', 'Amount', 'Rate', ...m.columns, `Total ${m.base}`]
    .map((t, i) => ({ text: L(t), style: 'colHead', alignment: i >= 4 ? 'right' : 'left' }));
  const body = [head];
  for (const r of m.rows) {
    body.push([
      { text: String(r.n), style: 'cell' }, { text: fmtDate(r.date), style: 'cell' }, { text: L(r.description), style: 'cell' },
      { text: r.currency || '', style: 'cell' }, { text: money(r.amount), style: 'cell', alignment: 'right' }, { text: r.foreign && r.rate ? String(r.rate) : '', style: 'cell', alignment: 'right' },
      ...m.columns.map(c => ({ text: r.cells[c] !== undefined ? money(r.cells[c]) : '', style: 'cell', alignment: 'right' })),
      { text: money(r.base), style: 'strong', alignment: 'right' },
    ]);
  }
  body.push([
    { text: 'Category totals', style: 'strong', colSpan: 6 }, {}, {}, {}, {}, {},
    ...m.columns.map(c => ({ text: money(m.categoryTotals[c] || 0), style: 'strong', alignment: 'right' })),
    { text: money(m.total), style: 'strong', alignment: 'right' },
  ]);

  const content = [
    { table: { widths: ['auto', '*', 'auto', '*'], body: cover.map(r => [{ text: r[0], style: 'label' }, { text: L(r[1]), style: 'value' }, { text: r[2], style: 'label' }, { text: L(r[3]), style: 'value' }]) }, layout: 'noBorders', margin: [0, 0, 0, 8] },
    { columns: [{ text: '', width: '*' }, { width: 'auto', table: { body: [
      [{ text: 'TOTAL REIMBURSEMENT', style: 'label', margin: [0, 4, 8, 0] }, { text: `${m.base} ${money(m.reimbursement)}`, style: 'big', alignment: 'right' }],
      [{ text: 'Advances received', style: 'label', margin: [0, 2, 8, 0] }, { text: `${m.base} ${money(m.advances)}`, style: 'value', alignment: 'right' }],
    ] }, layout: 'noBorders' }], margin: [0, 0, 0, 10] },
    { table: { headerRows: 1, dontBreakRows: true, widths: ['auto', 'auto', '*', 'auto', 'auto', 'auto', ...m.columns.map(() => 'auto'), 'auto'], body },
      layout: {
        hLineWidth: i => (i === 1 || i === body.length - 1 || i === body.length ? 0.7 : 0), hLineColor: () => RULE, vLineWidth: () => 0,
        fillColor: i => (i > 0 && i < body.length - 1 && i % 2 === 0 ? BAND : null),
        paddingTop: () => 3, paddingBottom: () => 3, paddingLeft: () => 4, paddingRight: () => 4,
      } },
    { text: 'EXCHANGE RATES', style: 'section', margin: [0, 12, 0, 2] },
    ...(m.rateNotes.length ? m.rateNotes.map(t => ({ text: L(t), style: 'note' })) : [{ text: `All amounts in ${m.base}.`, style: 'note' }]),
    ...m.notes.map(t => ({ text: L(t), style: 'note' })),
    { columns: [
      { width: '*', stack: [{ text: 'Claimant', style: 'label', margin: [0, 16, 0, 2] }, { text: L(owner.name || owner.email || ''), style: 'value' }, { text: report.submittedAt ? `submitted ${fmtDate(report.submittedAt)}` : 'not yet submitted', style: 'note' }] },
      { width: '*', stack: [{ text: 'Approved by', style: 'label', margin: [0, 16, 0, 2] }, { text: L(approver.name || approver.email || '—'), style: 'value' }, { text: report.approvedAt ? fmtStamp(report.approvedAt, company.timezone) : 'pending', style: 'note' }] },
      { width: '*', stack: [{ text: 'For office use', style: 'label', margin: [0, 16, 0, 2] }, { text: [report.paidAt ? `Paid ${fmtDate(report.paidAt)}` : 'Not yet paid', report.xeroInvoiceId ? `Xero ${report.xeroInvoiceId}` : null, `Receipts: ${receipts.length}${receipts.length ? ` (${receipts.map(r => r.ref).join(', ')})` : ''}`].filter(Boolean).join(' · '), style: 'note' }] },
    ] },
  ];
  for (const r of receipts) {
    content.push({ text: `${r.ref} · ${L(r.title || 'Receipt')}`, style: 'section', pageBreak: 'before' });
    if (!r.pages.length) content.push({ text: 'No image available for this receipt.', style: 'note' });
    r.pages.forEach((p, i) => content.push({ image: p.dataUri, fit: [770, 460], margin: [0, 6, 0, 6], ...(i > 0 ? { pageBreak: 'before' } : {}) }));
  }

  return {
    pageSize: 'A4', pageOrientation: 'landscape', pageMargins: [28, 56, 28, 30],
    defaultStyle: { font: 'Helvetica', fontSize: 8 },
    header: { margin: [28, 18, 28, 0], columns: [
      { width: '*', stack: [{ text: L(company.name || 'Company'), style: 'org' }, { text: 'Expense report', style: 'sub' }] },
      { width: 'auto', stack: [{ text: report.number, style: 'title', alignment: 'right' }, { text: `Generated ${fmtStamp(new Date(generatedAt).toISOString(), company.timezone)}`, style: 'sub', alignment: 'right' }] },
    ] },
    footer: (page, pages) => ({ margin: [28, 6, 28, 0], columns: [{ text: `${report.number} · ${L(owner.name || owner.email || '')}`, style: 'foot' }, { text: `Page ${page} of ${pages}`, style: 'foot', alignment: 'right' }] }),
    styles: {
      org: { fontSize: 11, bold: true, color: ACCENT }, title: { fontSize: 14, bold: true }, sub: { fontSize: 7.5, color: MUTED }, foot: { fontSize: 6.5, color: MUTED },
      label: { fontSize: 7, bold: true, color: MUTED, characterSpacing: 0.4 }, value: { fontSize: 9 }, big: { fontSize: 14, bold: true, color: ACCENT },
      colHead: { fontSize: 6.5, bold: true, color: MUTED }, cell: { fontSize: 7.5 }, strong: { fontSize: 7.5, bold: true },
      section: { fontSize: 8, bold: true, characterSpacing: 0.5 }, note: { fontSize: 7, color: '#374151', lineHeight: 1.25 },
    },
    content,
  };
}

function expenseReportCsv(payload) {
  const m = buildModel(payload);
  const { report, lines = [] } = payload;
  const esc = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const out = [['Report', 'Line', 'Date', 'Merchant', 'Description', 'Purpose', 'On behalf of', 'Category', 'Currency', 'Amount', 'Rate', 'Rate date', 'Rate source', m.base, 'Receipt'].join(',')];
  lines.forEach((l, i) => out.push([
    report.number, i + 1, l.date, l.merchant, l.description, l.purpose, l.onBehalfOf, l.category, l.currency, Number(l.amount).toFixed(2),
    l.fxRate === null || l.fxRate === undefined ? '' : fmtRate(l.fxRate), l.fxRateDate ?? '', l.fxSource ?? '', l.baseAmount === null || l.baseAmount === undefined ? '' : Number(l.baseAmount).toFixed(2), l.ref,
  ].map(esc).join(',')));
  return out.join('\n');
}

function workbookModel(payload) {
  const m = buildModel(payload);
  const { company, report, owner = {}, manager = {}, approver = {}, lines = [], receipts = [] } = payload;
  return { sheets: [
    { name: 'Cover', rows: [['Report', report.number], ['Company', company.name], ['Employee', owner.name || owner.email], ['Employee ID', owner.employeeId], ['Department', owner.department], ['Manager', manager.name],
      ['Purpose', report.purpose || report.title], ['From', report.periodFrom], ['To', report.periodTo], ['Destination', report.destination], ['Status', report.status], ['Approved by', approver.name],
      ['Approved at', report.approvedAt], ['Advances', m.advances], [`Total ${m.base}`, m.total], [`Reimbursement ${m.base}`, m.reimbursement]] },
    { name: 'Lines', header: ['#', 'Date', 'Merchant', 'Description', 'Purpose', 'On behalf of', 'Category', 'Currency', 'Amount', 'Rate', 'Rate date', 'Rate source', m.base, 'Receipt'],
      rows: lines.map((l, i) => [i + 1, l.date, l.merchant, l.description, l.purpose, l.onBehalfOf, l.category, l.currency, Number(l.amount), l.fxRate === null || l.fxRate === undefined ? '' : Number(fmtRate(l.fxRate)), l.fxRateDate, l.fxSource, l.baseAmount, l.ref]),
      money: [9, 13], totalLabel: `Total ${m.base}`, total: m.total },
    { name: 'Rates', rows: [...m.rateNotes.map(t => [t]), ...m.notes.map(t => [t])] },
    { name: 'Receipts', header: ['Ref', 'Receipt', 'Pages'], rows: receipts.map(r => [r.ref, r.title, r.pages.length]) },
  ] };
}

function exportFilename(payload) {
  const who = String(payload.owner?.name || payload.owner?.email || 'claimant').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'claimant';
  return `${payload.report.number}_${who}`;
}

module.exports = {
  fmtRate, buildModel, expenseReportDoc, expenseReportCsv, workbookModel, exportFilename, _money: money, _fmtDate: fmtDate, _latin1: latin1 };
