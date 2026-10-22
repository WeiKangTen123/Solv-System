import { fmtDay } from '../../utils/format';

// The fields of one receipt, and the small rules about them that the receipt
// page (pages/ExpenseReview.jsx) and the case review (pages/CaseReview.jsx)
// share. They were written out inside ExpenseReview; a second copy in the
// review page is how two screens come to disagree about what "changed" means.

// Every field either page can show. `wide` spans both columns of the form.
export const FIELD_DEFS = {
  merchant:    { label: 'Merchant', type: 'text', wide: true },
  receiptDate: { label: 'Receipt date', type: 'date' },
  receiptTime: { label: 'Time', type: 'text' },
  invoiceNo:   { label: 'Invoice no.', type: 'text' },
  currency:    { label: 'Currency', type: 'text', placeholder: 'IDR' },
  total:       { label: 'Total', type: 'number' },
  tax:         { label: 'Tax included', type: 'number' },
  category:    { label: 'Category', type: 'select' },
  purpose:     { label: 'Business purpose', type: 'text', wide: true, placeholder: 'Client site visit, Chakan plant' },
  description: { label: 'Description', type: 'text', wide: true, placeholder: 'What was bought, if the merchant does not say' },
};

// The receipt's own page: the category is on its lines there, and the
// reader's description is shown as a note rather than a box.
export const PAGE_FIELDS = ['merchant', 'receiptDate', 'receiptTime', 'invoiceNo', 'currency', 'total', 'tax', 'purpose'];
// The case review: one screen per receipt, so everything a claim needs is a
// box, and the category of a one-line receipt is a field like any other.
export const REVIEW_FIELDS = ['merchant', 'receiptDate', 'invoiceNo', 'currency', 'total', 'tax', 'category', 'purpose', 'description'];

export const cents = v => Math.round(Number(v || 0) * 100);
// The lines as the server would store them, to tell whether they were edited.
export const sameLines = ls => JSON.stringify(ls.map(l => [l.category || '', l.description || '', cents(l.amount), String(l.onBehalfOf || '').trim()]));

// The category a receipt reports under: its one line's, or its own while it
// has no lines. A receipt split into several has none of its own (receipts/edit.js
// categoryOf says the same on the server).
export const categoryOf = e => ((e.lines || []).length === 1 ? e.lines[0].category : (e.lines || []).length > 1 ? null : e.category) || '';

// What the boxes start from. A receipt nobody has an amount for yet comes
// back with a total of 0; the box is left empty for it rather than saying 0.
export function pick(e, fields) {
  const start = k => (k === 'category' ? categoryOf(e) : k === 'total' && !(Number(e.total) > 0) ? '' : (e[k] ?? ''));
  return Object.fromEntries(fields.map(k => [k, start(k)]));
}
export function lineRows(e) {
  return (e.lines || []).map(l => ({ category: l.category || '', description: l.description || '', amount: l.amount, onBehalfOf: l.onBehalfOf || '' }));
}

// What the reader first read off the paper for a field, or undefined when it
// read nothing there (receipts/read-receipt.js keeps it as `aiRead`).
export function aiValue(e, k) {
  const v = e && e.aiRead ? e.aiRead[k] : undefined;
  return v === null || v === '' ? undefined : v;
}
const MONEY = new Set(['total', 'tax']);
// Two values of one field that say the same thing: amounts as numbers, text
// without case or edge spaces.
export function sameValue(k, a, b) {
  if (MONEY.has(k)) return a !== '' && a !== null && a !== undefined && b !== '' && b !== null && b !== undefined && Number(a) === Number(b);
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}
// Where the saved receipt no longer says what the reader read, so a figure
// that drifted from the paper shows at a glance. Against what is saved, not
// what is being typed: the hint is about the record.
export function aiDiffers(e, k) {
  const read = aiValue(e, k);
  if (read === undefined) return false;
  const saved = k === 'category' ? categoryOf(e) : e[k];
  return !sameValue(k, read, saved);
}
export function aiShown(k, v) {
  if (MONEY.has(k)) return Number(v).toFixed(2);
  if (k === 'receiptDate') return fmtDay(v, { withYear: true });
  return String(v);
}

// The flags (receipts/flags.js) a field should show beside it, and the ones
// that name no field on screen, which the page lists above the form instead.
export const flagsOn = (flags, field) => (flags || []).filter(f => f.field === field);
export const flagsOff = (flags, shown) => (flags || []).filter(f => !f.field || !shown.includes(f.field));
export const hasRed = e => (e.flags || []).some(f => f.level === 'red');

// The fields a refusal from the server is about. receipts/edit.js says
// "Fill in the merchant, date before marking this reviewed" and "The lines do
// not add up to the receipt total"; marking those boxes puts the reason where
// it has to be fixed.
export function refusedFields(message) {
  const m = String(message || '').toLowerCase();
  const out = [];
  const fill = /fill in the ([a-z ,]+?) before/.exec(m);
  if (fill) {
    const named = fill[1].split(',').map(s => s.trim());
    if (named.includes('merchant')) out.push('merchant');
    if (named.includes('date')) out.push('receiptDate');
    if (named.includes('currency')) out.push('currency');
    if (named.includes('total')) out.push('total');
  }
  if (/lines/.test(m)) out.push('lines');
  if (/currency must/.test(m)) out.push('currency');
  if (/^date must/.test(m)) out.push('receiptDate');
  if (/^total must/.test(m)) out.push('total');
  if (/^tax must/.test(m)) out.push('tax');
  if (/unknown category/.test(m)) out.push('category');
  return out;
}
