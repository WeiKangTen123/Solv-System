// What an expense report says, as plain data. buildModel() decides rows,
// columns, totals and notes; expenseReportCsv() and workbookModel() reuse it,
// and so does the PDF (expense-pdf.js), so the three exports cannot disagree.
// Nothing here renders a byte.
const { SOURCE_LONG: SOURCE_LABEL, SOURCE_VIA: VIA } = require('../fx/sources');
const POLICY_LABEL = { receipt_date: 'rate on the receipt date', submission_date: 'rate on the submission date', monthly_fixed: 'monthly fixed rate table' };

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
    const pending = l.baseAmount === null || l.baseAmount === undefined;
    return { n: i + 1, ref: l.ref, date: l.date, description: desc, currency: l.currency, amount: l.amount, rate: fmtRate(l.fxRate), base: l.baseAmount, pending, column: col, cells: pending ? {} : { [col]: l.baseAmount }, onBehalfOf: l.onBehalfOf || null, foreign: l.currency !== base };
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
  const pendingRows = rows.filter(r => r.pending).length;
  if (pendingRows) notes.push(`${pendingRows} line${pendingRows === 1 ? ' has' : 's have'} no exchange rate yet and ${pendingRows === 1 ? 'is' : 'are'} not in the totals.`);
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

function expenseReportCsv(payload) {
  const m = buildModel(payload);
  const { report, lines = [] } = payload;
  // A cell that starts with = + - @ or a tab is a formula to Excel, quoted or
  // not, and merchants, descriptions and purposes come from receipts and from
  // people. "=HYPERLINK(...)" read off a doctored receipt became a live link in
  // finance's spreadsheet. Such text gets a leading apostrophe, which Excel
  // shows as nothing and reads as text. A plain number such as -12.50 is left
  // as it is.
  const esc = v => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [['Report', 'Line', 'Date', 'Merchant', 'Description', 'Purpose', 'On behalf of', 'Category', 'Currency', 'Amount', 'Rate', 'Rate date', 'Rate source', m.base, 'Receipt'].join(',')];
  lines.forEach((l, i) => out.push([
    report.number, i + 1, l.date, l.merchant, l.description, l.purpose, l.onBehalfOf, l.category, l.currency, Number(l.amount).toFixed(2),
    l.fxRate === null || l.fxRate === undefined ? '' : fmtRate(l.fxRate), l.fxRateDate ?? '', l.fxSource ?? '', l.baseAmount === null || l.baseAmount === undefined ? '' : Number(l.baseAmount).toFixed(2), l.ref,
  ].map(esc).join(',')));
  return out.join('\n');
}

function workbookModel(payload) {
  const m = buildModel(payload);
  const { company, report, owner = {}, lines = [], receipts = [] } = payload;
  return { sheets: [
    { name: 'Cover', rows: [['Case', report.number], ['Company', company.name], ['Employee', owner.name || owner.email], ['Employee ID', owner.employeeId], ['Department', owner.department],
      ['Purpose', report.purpose || report.title], ['From', report.periodFrom], ['To', report.periodTo], ['Destination', report.destination], ['Status', report.status],
      ['Claimed at', report.claimedAt], ['Advances', m.advances], [`Total ${m.base}`, m.total], [`Reimbursement ${m.base}`, m.reimbursement]] },
    { name: 'Lines', header: ['#', 'Date', 'Merchant', 'Description', 'Purpose', 'On behalf of', 'Category', 'Currency', 'Amount', 'Rate', 'Rate date', 'Rate source', m.base, 'Receipt'],
      rows: lines.map((l, i) => [i + 1, l.date, l.merchant, l.description, l.purpose, l.onBehalfOf, l.category, l.currency, Number(l.amount), l.fxRate === null || l.fxRate === undefined ? '' : Number(fmtRate(l.fxRate)), l.fxRateDate, l.fxSource, l.baseAmount, l.ref]),
      money: [9, 13], totalLabel: `Total ${m.base}`, total: m.total },
    { name: 'Rates', header: ['Notes'], rows: (m.rateNotes.length || m.notes.length)
      ? [...m.rateNotes.map(t => [t]), ...m.notes.map(t => [t])]
      : [[`Every line is in ${m.base}; no exchange rate was needed.`]] },
    { name: 'Receipts', header: ['Ref', 'Receipt', 'Pages'], rows: receipts.map(r => [r.ref, r.title, r.pages.length]) },
  ] };
}

function exportFilename(payload) {
  const who = String(payload.owner?.name || payload.owner?.email || 'claimant').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'claimant';
  return `${payload.report.number}_${who}`;
}

module.exports = {
  fmtRate, fmtDate, fmtStamp, POLICY_LABEL, buildModel, expenseReportCsv, workbookModel, exportFilename, _fmtDate: fmtDate };
