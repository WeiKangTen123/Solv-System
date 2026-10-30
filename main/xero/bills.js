const crypto = require('crypto');
const { Readable } = require('stream');
const reports = require('../store/reports');
const users   = require('../store/users');
const { reportPayload } = require('../reports/expense-payload');
const { getOrCreateContact } = require('./contacts');
const { accountForCategory, getAccounts, getTaxRates } = require('./category-account');
const { fmtRate, taxName } = require('../reports/expense-doc');
const attachments = require('./attachments');
const { withRetry, xeroErrMsg } = require('./xero-utils');
const { _fmtDate: fmtDate } = require('../reports/expense-doc');
const store   = require('../store/expenses');
const { localDate, addDays } = require('../utils/zone-date');
const { fail, HttpError } = require('../utils/http-error');
const logger  = require('../utils/logger');

// A claimed case becomes ONE draft bill in Xero, payable to the claimant,
// in the company's base currency: one line per report line at its base
// amount, so the bill equals the printed report to the cent. The original
// currency, amount and rate ride in each line's description.
const { formatAmount: money } = require('../utils/money');
const DUE_DAYS = 7;

// Which purchase tax a taxed line carries. The account's own default first:
// Xero keeps one per account, and a Singapore organisation has several 9%
// purchase types (standard-rated, blocked input tax, imports), where taking
// "the highest rate" left the choice to whichever one Xero listed first and
// could code input tax as blocked. Then a standard-rated purchase type by
// name, then the highest rate that is not one of the special kinds. When only
// special kinds exist there is no right guess: null, and the line goes
// without a tax type so Xero applies the account's own.
const SPECIAL_TAX = /blocked|import|reverse|exempt|out[- ]of[- ]scope|disregarded|zero/i;
function purchaseTax(accountCode, accounts, active) {
  const positive = active.filter(r => Number(r.displayTaxRate) > 0);
  const account = accountCode ? accounts.find(a => String(a.code) === String(accountCode)) : null;
  const own = account && account.taxType ? positive.find(r => r.taxType === account.taxType) : null;
  if (own) return own;
  const standard = positive.find(r => /standard[- ]rated purchases/i.test(r.name || '') || r.taxType === 'INPUT');
  if (standard) return standard;
  const byRate = list => [...list].sort((a, b) => Number(b.displayTaxRate) - Number(a.displayTaxRate))[0] || null;
  return byRate(positive.filter(r => !SPECIAL_TAX.test(r.name || '')));
}

// The purchase tax for a tax as a receipt printed it, by its rate: SST 6% to
// the organisation's 6% type, a KL hotel room's Service Tax 8% to its 8% one,
// CGST 9% and SGST 9% charged together to an 18% one. Of several at that
// rate, the account's own, then one named like the tax ("Service Tax 8%" for
// "Service Tax"), then standard-rated purchases, never one of the special
// kinds. Nothing at that rate: null, and the caller goes on as before.
function taxForRate(rate, labels, accountCode, accounts, active) {
  if (!(rate > 0)) return null;
  const same = active.filter(r => Math.abs(Number(r.displayTaxRate) - rate) < 0.0001);
  if (!same.length) return null;
  const account = accountCode ? accounts.find(a => String(a.code) === String(accountCode)) : null;
  const own = account && account.taxType ? same.find(r => r.taxType === account.taxType) : null;
  if (own) return own;
  const plain = same.filter(r => !SPECIAL_TAX.test(r.name || ''));
  const words = labels.map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
  return plain.find(r => words.some(w => String(r.name || '').toLowerCase().includes(w)))
    || plain.find(r => /standard[- ]rated purchases/i.test(r.name || '') || r.taxType === 'INPUT')
    || plain[0] || null;
}

const cents = n => Math.round(Number(n || 0) * 100);
const ROUNDING_CENTS = 5;
// A base-currency line of a receipt kept as printed (line.taxes, see
// reports/expense-payload.js): one bill line for each part of it a tax was
// charged on, at that part's amount with the tax as printed, and the rest on
// a line of its own on the zero type. Taxes charged on the same part go
// together, CGST with SGST, as one line at their combined rate. A KL hotel's
// room line is the room's Service Tax 8% on one bill line and the tourism
// tax, which no tax was charged on, on another; summed into one line at the
// organisation's top rate, as it used to be, Xero coded the whole of it as
// taxed. Null when the taxes do not say what they were charged on: the line
// then goes as before.
function printedLines(l, item, { accountCode, accounts, active, zeroType }) {
  const taxes = l.taxes.filter(t => cents(t.amount) > 0);
  const total = cents(l.baseAmount);
  if (!taxes.length) return [item(total / 100, zeroType)];
  if (taxes.some(t => !(cents(t.gross) > 0))) return null;
  const rate = Number(l.fxRate) > 0 ? Number(l.fxRate) : 1;
  const inBase = (v, given) => (given !== null && given !== undefined ? cents(given) : Math.round(cents(v) * rate));
  const parts = new Map();
  for (const t of taxes) {
    const key = cents(t.gross);
    const p = parts.get(key) || { taxes: [], gross: inBase(t.gross, t.baseGross), tax: 0 };
    p.taxes.push(t); p.tax += inBase(t.amount, t.baseAmount);
    parts.set(key, p);
  }
  const list = [...parts.values()];
  let rest = total - list.reduce((s, p) => s + p.gross, 0);
  // The receipt's own rounding (the nasi kandar's −0.02), or a cent from each
  // part rounding on its own, goes into the largest part: a bill line of
  // −0.02 tells finance nothing. More than that, either way, is a part of the
  // line no tax was charged on, and goes on its own.
  if (rest && Math.abs(rest) <= ROUNDING_CENTS) {
    list.reduce((a, b) => (b.gross > a.gross ? b : a)).gross += rest;
    rest = 0;
  }
  if (list.some(p => p.gross <= 0)) return null;
  const out = list.map(p => {
    const rates = p.taxes.map(t => Number(t.rate));
    const combined = rates.every(r => Number.isFinite(r) && r > 0) ? Math.round(rates.reduce((a, b) => a + b, 0) * 10000) / 10000 : null;
    // No type to choose from: no tax type and no tax amount, so Xero applies
    // the account's own, as a taxed line always has.
    const type = taxForRate(combined, p.taxes.map(t => t.label), accountCode, accounts, active) || purchaseTax(accountCode, accounts, active);
    return item(p.gross / 100, type ? type.taxType : undefined, type ? p.tax / 100 : undefined, p.taxes.map(taxName).join(' + '));
  });
  if (rest) out.push(item(rest / 100, zeroType, undefined, 'not taxed'));
  return out;
}

// Pure: the bill as Xero will receive it, minus the contact id.
function buildBill(payload, { accounts = [], defaultAccountCode = null, advancesAccountCode = null, taxRates = [] } = {}) {
  const { company, report, owner = {}, lines = [], receipts = [] } = payload;
  const base = company.baseCurrency;
  const active = taxRates.filter(r => String(r.status || 'ACTIVE').toUpperCase() === 'ACTIVE' && r.canApplyToExpenses !== false);
  const zero = active.find(r => Number(r.displayTaxRate || 0) === 0) || null;
  const zeroType = zero ? zero.taxType : 'NONE';

  const lineItems = lines.flatMap(l => {
    const accountCode = accountForCategory(l.category, accounts) || defaultAccountCode || undefined;
    const foreign = !!l.currency && l.currency !== base;
    const description = [
      fmtDate(l.date), l.merchant, l.category, l.purpose,
      l.onBehalfOf ? `on behalf of ${l.onBehalfOf}` : null,
      foreign ? `${l.currency} ${money(l.amount)} × ${fmtRate(l.fxRate)}` : null,
    ].filter(Boolean).join(' · ');
    const item = (unitAmount, taxType, taxAmount, said) => ({
      description: (said ? `${description} · ${said}` : description).slice(0, 4000), quantity: 1, unitAmount,
      ...(accountCode ? { accountCode } : {}), ...(taxType ? { taxType } : {}),
      ...(taxAmount ? { taxAmount: Math.round(taxAmount * 100) / 100 } : {}),
    });
    const printed = !foreign && Array.isArray(l.taxes) ? printedLines(l, item, { accountCode, accounts, active, zeroType }) : null;
    if (printed) return printed;
    // Local GST only where the receipt shows tax in the base currency; foreign tax is never input tax.
    const wantsTax = !foreign && Number(l.tax) > 0;
    const gst = wantsTax ? purchaseTax(accountCode, accounts, active) : null;
    const taxed = !!gst;
    const taxType = taxed ? gst.taxType : wantsTax ? undefined : zeroType;
    // Send the tax the receipt actually printed. Left to itself Xero derives it
    // from the rate, which is only right when the receipt was taxed at exactly
    // the organisation's top rate.
    const taxAmount = taxed ? Number(l.baseTax ?? l.tax ?? 0) : undefined;
    return [item(Number(l.baseAmount || 0), taxType, taxAmount)];
  });
  // The cover deducts any advance already paid, and the PDF prints the smaller
  // figure as TOTAL REIMBURSEMENT. The bill has to agree, or finance pays the
  // advance a second time: a negative line, so the total lands on what is owed.
  // It goes against the advances account, which clears what the claimant was
  // given. Taken off the expense account, as it used to be, it understated the
  // expense and left the advance owed in the books for ever.
  const advances = Math.round(Number(report.advances || 0) * 100) / 100;
  if (advances > 0) {
    lineItems.push({
      description: `Less advance already paid to ${owner.name || owner.email || 'the claimant'}`,
      quantity: 1, unitAmount: -advances,
      ...(advancesAccountCode ? { accountCode: advancesAccountCode } : {}),
      taxType: zeroType,
    });
  }

  // The day it was claimed where the company is: a claim at 07:30 in
  // Singapore was dated the day before in UTC, which can be a closed period.
  const date = localDate(company.timezone || 'Asia/Singapore', report.claimedAt ? new Date(report.claimedAt) : new Date());
  return {
    contact: { name: owner.name || owner.email || 'Claimant', email: owner.email || '' },
    invoice: {
      type: 'ACCPAY', status: 'DRAFT', date, dueDate: addDays(date, DUE_DAYS),
      invoiceNumber: report.number, reference: report.title || report.purpose || report.number,
      currencyCode: base, lineAmountTypes: 'Inclusive', lineItems,
    },
    total: Math.round(lineItems.reduce((s, l) => s + Math.round(l.unitAmount * 100), 0)) / 100,
    attachments: receipts.map(r => r.ref),
  };
}

// What would make the bill wrong. Details stay correctable after a claim
// (receipts/edit.js), so what claiming checked has to be asked again here:
// a line that lost its rate posted as 0.00, and a split whose total changed
// posted its old lines.
function postProblems(r) {
  const out = [];
  const name = e => e.merchant || 'a receipt';
  const unpriced = r.expenses.filter(e => !e.lines.length || e.lines.some(l => l.baseAmount === null || l.baseAmount === undefined));
  if (unpriced.length) out.push(`${unpriced.map(name).join(', ')} ${unpriced.length === 1 ? 'has' : 'have'} no exchange rate`);
  const off = r.expenses.filter(e => e.lines.length && !store.linesReconcile(e.lines, store.toCents(e.total)));
  if (off.length) out.push(`the lines of ${off.map(name).join(', ')} do not add up to the receipt total`);
  const odd = r.expenses.filter(e => ['reading', 'duplicate', 'rejected'].includes(e.status));
  if (odd.length) out.push(`${odd.map(name).join(', ')} ${odd.length === 1 ? 'is' : 'are'} ${odd.map(e => e.status).join('/')}`);
  return out;
}

// What has to be true of the case before a bill is built from it. Asked
// once for the early answer and again under the posting claim, because the
// case can change in between.
function _assertPostable(r) {
  if (!r) fail(404, 'Case not found');
  if (r.xeroInvoiceId) fail(409, `This case is already in Xero as bill ${r.xeroInvoiceId}`);
  if (r.status !== 'claimed') fail(409, 'Only a claimed case can be posted to Xero');
  if (!r.expenses.length) fail(400, 'This case has no receipts to post');
  const problems = postProblems(r);
  if (problems.length) fail(400, `Fix this before posting: ${problems.join('; ')}.`);
}

async function _bill(reportId, company, tenant) {
  const payload = await reportPayload(reportId, { withReceipts: false });
  const config  = users.getCompanyConfig(company.id);
  let accounts = [], taxRates = [];
  if (tenant) {
    try { accounts = await getAccounts(company.id, tenant.tenantId); } catch (err) { logger.warn('Chart of accounts unavailable; using the default account', { error: xeroErrMsg(err) }); }
    try { taxRates = await getTaxRates(company.id, tenant.tenantId); } catch (err) { logger.warn('Tax rates unavailable; lines go without a tax type', { error: xeroErrMsg(err) }); }
  }
  const bill = buildBill(payload, { accounts, taxRates, defaultAccountCode: config.DEFAULT_ACCOUNT_CODE || null, advancesAccountCode: config.ADVANCES_ACCOUNT_CODE || null });
  return { bill, config, advances: Number(payload.report.advances || 0) };
}

// The same bill always sends the same key, and a different bill a different
// one. A retry of a reply lost on the way back, a second click, or a takeover
// of a post that died after Xero made the bill all get the first bill back
// instead of a second; a case corrected after Xero refused it is a different
// bill and still posts. The key used to carry the time, so every attempt was
// new to Xero.
function idempotencyKey(reportId, bill) {
  const digest = crypto.createHash('sha256').update(JSON.stringify({ c: bill.contact, i: bill.invoice })).digest('hex').slice(0, 24);
  return `solv-${reportId}-${digest}`;
}

// What goes up with the bill, as [{ label, files }]: each receipt file as
// attachments.forReceipt prepares it, under the same R1, R2… the printed
// report gives it. A receipt-less line (per diem, mileage) has nothing to
// send. Xero takes ten attachments on a bill, and a PDF too big to send whole
// is already a picture a page, so a case can need more: then the case PDF
// goes instead, cover and every receipt, in as few files as fit (casePdfs).
// What cannot go at all is said in `warnings`, which the case keeps.
//
// Counted as they are made, so a case of fifty receipts holds eleven before
// it turns to the PDF, not fifty.
async function _attachments(r, warnings) {
  const refs = require('../reports/expense-payload').receiptRefs(r.expenses);
  const max = attachments.MAX_FILES;
  const each = [];
  const unread = [];
  let count = 0;
  const seen = new Set();
  for (const e of r.expenses) {
    if (!e.receipt || seen.has(e.receipt.id)) continue;
    seen.add(e.receipt.id);
    const ref = refs.get(e.receipt.id);
    let files;
    try { files = await attachments.forReceipt(e.receipt, { ref }); }
    catch (err) {
      // The bill exists already: a receipt that cannot be prepared is noted,
      // as one Xero refuses is, and the rest still go.
      logger.warn('Receipt not prepared for the Xero bill', { reportId: r.id, ref, error: err.message });
      unread.push(`${ref}: ${err.message}`);
      continue;
    }
    count += files.length;
    if (count > max) return _asCasePdf(r, warnings, max);
    each.push({ label: ref, files });
  }
  warnings.push(...unread);
  return each;
}

async function _asCasePdf(r, warnings, max) {
  let out;
  try {
    out = await attachments.casePdfs(await reportPayload(r.id, { withReceipts: true }));
  } catch (err) {
    logger.warn('The case PDF could not be made for the Xero bill', { reportId: r.id, error: err.message });
    warnings.push('Receipts: the case PDF could not be made, so none were attached. Attach the PDF export in Xero.');
    return [];
  }
  logger.info('Receipts sent to Xero as the case PDF', { reportId: r.id, files: out.files.length, left: out.left.length });
  if (out.left.length) {
    const mb = Math.round(attachments.MAX_BYTES / (1024 * 1024));
    warnings.push(`${out.left.join(', ')}: more than fits in the ${max} files of ${mb} MB Xero takes on a bill. They are in the case's PDF export.`);
  }
  return out.files.map(f => ({ label: f.refs.length > 1 ? `${f.refs[0]}-${f.refs.at(-1)}` : f.refs[0], files: [f] }));
}

async function postReport(reportId, actor, { dryRun = false } = {}) {
  const first = reports.getReport(reportId);
  _assertPostable(first);
  const company = users.getCompany(first.companyId);
  const tokenCache = require('./token-cache');
  const tenant = tokenCache.getPersistedTenants(company.id)[0] || null;

  if (dryRun) {
    const { bill, config, advances } = await _bill(reportId, company, tenant);
    return { dryRun: true, tenantId: tenant ? tenant.tenantId : null, tenantName: tenant ? tenant.tenantName : null, bill,
             needsAdvancesAccount: advances > 0 && !config.ADVANCES_ACCOUNT_CODE };
  }
  if (!tenant) fail(400, 'Xero is not connected. Connect the organisation in Settings first.');

  // The claim comes first, and only a claimed case can take it (store/reports.js).
  // The checks and the bill used to be made before it: while the chart of
  // accounts loaded, the case could be reopened and changed, or a receipt
  // corrected, and Xero got one amount while the case went on to say another.
  // Under the claim, reopening and detail edits are refused (workflow.js,
  // receipts/edit.js), so what is read now is what is posted.
  if (!reports.claimForPost(reportId)) fail(409, 'This case is already being posted to Xero, or is no longer claimed. Reload it.');

  // Everything up to the bill existing either succeeds or releases the claim.
  // The token fetch used to sit outside this, so a failed refresh left the
  // case marked "being posted" for good and every later attempt refused.
  let r, bill, created, api;
  try {
    r = reports.getReport(reportId);
    _assertPostable(r);
    const built = await _bill(reportId, company, tenant);
    bill = built.bill;
    if (built.advances > 0 && !built.config.ADVANCES_ACCOUNT_CODE) {
      fail(400, 'Set the advances account in Settings → Xero before posting a case with an advance, so the advance is cleared where it was paid from.');
    }
    // Xero refuses a bill below zero, so advances above the claim cannot post.
    if (bill.total < 0) fail(400, `The advances are more than the claim, so the bill would be ${money(bill.total)}. Lower the advance on the case cover first.`);

    const { AccountingApi } = require('xero-node');
    const token = await tokenCache.forCompany(company.id).getValidToken(tenant.tenantId);
    api = new AccountingApi();
    api.accessToken = token;
    const contactID = await getOrCreateContact(company.id, tenant.tenantId, { vendorName: bill.contact.name, email: bill.contact.email, invoiceType: 'ACCPAY' });
    const key = idempotencyKey(reportId, bill);
    const res = await withRetry(() => api.createInvoices(tenant.tenantId, { invoices: [{ ...bill.invoice, contact: { contactID } }] }, undefined, undefined, key));
    created = res.body.invoices[0];
    if (!created || !created.invoiceID) throw new Error('Xero answered without a bill');
  } catch (err) {
    // Our own refusal (a case that changed, a missing setting) keeps its
    // words and status; anything from Xero is said as Xero's.
    const ours = err instanceof HttpError;
    const msg = ours ? err.message : xeroErrMsg(err);
    reports.releasePost(reportId, ours ? null : msg);
    if (!ours) reports.addEvent(reportId, actor.id, 'xero_failed', msg);
    if (ours) throw err;
    throw new HttpError(502, `Xero refused the bill: ${msg}`);
  }

  // The bill exists: record it now, before the attachments. It used to be
  // recorded only after every receipt was attached, so a restart part-way left
  // a bill in Xero, a case that did not know it, and a 'posting' marker that
  // refused every later attempt. If this process stops during the uploads the
  // case still knows its bill, and the note says to check the attachments.
  // Recorded once: a bill already on the case is never overwritten.
  const warnings = [];
  if (!reports.recordBill(reportId, created.invoiceID, 'Receipts were still being attached when this was last checked. Check the bill in Xero.')) {
    const kept = reports.head(reportId);
    if (kept && kept.xeroInvoiceId !== created.invoiceID) {
      logger.error('Xero made a second bill for a case that already had one', { reportId, kept: kept.xeroInvoiceId, extra: created.invoiceID });
      reports.addEvent(reportId, actor.id, 'xero_failed', `Xero also made bill ${created.invoiceID}; the case keeps ${kept.xeroInvoiceId}. Delete the extra draft in Xero.`);
      return { dryRun: false, tenantId: tenant.tenantId, tenantName: tenant.tenantName, xeroInvoiceId: kept.xeroInvoiceId,
               warnings: [`Xero also made a second draft bill (${created.invoiceID}); delete it in Xero.`], bill };
    }
  }
  reports.addEvent(reportId, actor.id, 'posted', `Xero bill ${created.invoiceID}`);

  // Receipts, best-effort: a rejected attachment is noted, never a reason to
  // lose the bill that was just created.
  for (const item of await _attachments(r, warnings)) {
    try {
      for (const a of item.files) {
        await withRetry(() => api.createInvoiceAttachmentByFileName(tenant.tenantId, created.invoiceID, a.name, Readable.from(a.buffer), false, `${created.invoiceID}-${a.name}`.slice(0, 128)));
      }
    } catch (err) {
      warnings.push(`${item.label}: ${xeroErrMsg(err)}`);
      logger.warn('Receipt not attached to the Xero bill', { reportId, ref: item.label, error: xeroErrMsg(err) });
    }
  }

  // The status stays claimed: xero_invoice_id is what records the posting.
  reports.setState(reportId, { xeroError: warnings.length ? `Attachments: ${warnings.join('; ')}` : null });
  logger.info('Report posted to Xero', { reportId, number: r.number, invoiceID: created.invoiceID, lines: bill.invoice.lineItems.length, by: actor.id });
  return { dryRun: false, tenantId: tenant.tenantId, tenantName: tenant.tenantName, xeroInvoiceId: created.invoiceID, warnings, bill };
}

module.exports = { buildBill, postReport, postProblems, purchaseTax, taxForRate, idempotencyKey, DUE_DAYS };
