const { Readable } = require('stream');
const reports = require('../store/reports');
const users   = require('../store/users');
const { reportPayload } = require('../reports/expense-payload');
const { getOrCreateContact } = require('./contacts');
const { accountForCategory, getAccounts, getTaxRates } = require('./category-account');
const { fmtRate } = require('../reports/expense-doc');
const attachments = require('./attachments');
const { withRetry, xeroErrMsg } = require('./xero-utils');
const { _fmtDate: fmtDate } = require('../reports/expense-doc');
const store   = require('../store/expenses');
const { localDate } = require('../utils/zone-date');
const logger  = require('../utils/logger');

function fail(status, message) { const err = new Error(message); err.status = status; throw err; }

// A claimed case becomes ONE draft bill in Xero, payable to the claimant,
// in the company's base currency: one line per report line at its base
// amount, so the bill equals the printed report to the cent. The original
// currency, amount and rate ride in each line's description.
const money = n => require('../utils/money').formatAmount(n);
const DUE_DAYS = 7;

function _plusDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Pure: the bill as Xero will receive it, minus the contact id.
function buildBill(payload, { accounts = [], defaultAccountCode = null, taxRates = [] } = {}) {
  const { company, report, owner = {}, lines = [], receipts = [] } = payload;
  const base = company.baseCurrency;
  const active = taxRates.filter(r => String(r.status || 'ACTIVE').toUpperCase() === 'ACTIVE' && r.canApplyToExpenses !== false);
  const gst  = active.filter(r => Number(r.displayTaxRate) > 0).sort((a, b) => Number(b.displayTaxRate) - Number(a.displayTaxRate))[0] || null;
  const zero = active.find(r => Number(r.displayTaxRate || 0) === 0) || null;
  const zeroType = zero ? zero.taxType : 'NONE';

  const lineItems = lines.map(l => {
    const accountCode = accountForCategory(l.category, accounts) || defaultAccountCode || undefined;
    const foreign = !!l.currency && l.currency !== base;
    const description = [
      fmtDate(l.date), l.merchant, l.category, l.purpose,
      l.onBehalfOf ? `on behalf of ${l.onBehalfOf}` : null,
      foreign ? `${l.currency} ${money(l.amount)} × ${fmtRate(l.fxRate)}` : null,
    ].filter(Boolean).join(' · ').slice(0, 4000);
    // Local GST only where the receipt shows tax in the base currency; foreign tax is never input tax.
    const taxed = !foreign && Number(l.tax) > 0 && gst;
    const taxType = taxed ? gst.taxType : zeroType;
    // Send the tax the receipt actually printed. Left to itself Xero derives it
    // from the rate, which is only right when the receipt was taxed at exactly
    // the organisation's top rate.
    const taxAmount = taxed ? Number(l.baseTax ?? l.tax ?? 0) : undefined;
    return { description, quantity: 1, unitAmount: Number(l.baseAmount || 0), ...(accountCode ? { accountCode } : {}), taxType,
             ...(taxAmount ? { taxAmount: Math.round(taxAmount * 100) / 100 } : {}) };
  });
  // The cover deducts any advance already paid, and the PDF prints the smaller
  // figure as TOTAL REIMBURSEMENT. The bill has to agree, or finance pays the
  // advance a second time: a negative line, so the total lands on what is owed.
  const advances = Math.round(Number(report.advances || 0) * 100) / 100;
  if (advances > 0) {
    lineItems.push({
      description: `Less advance already paid to ${owner.name || owner.email || 'the claimant'}`,
      quantity: 1, unitAmount: -advances,
      ...(defaultAccountCode ? { accountCode: defaultAccountCode } : {}),
      taxType: zeroType,
    });
  }

  // The day it was claimed where the company is: a claim at 07:30 in
  // Singapore was dated the day before in UTC, which can be a closed period.
  const date = localDate(company.timezone || 'Asia/Singapore', report.claimedAt ? new Date(report.claimedAt) : new Date());
  return {
    contact: { name: owner.name || owner.email || 'Claimant', email: owner.email || '' },
    invoice: {
      type: 'ACCPAY', status: 'DRAFT', date, dueDate: _plusDays(date, DUE_DAYS),
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

async function postReport(reportId, actor, { dryRun = false } = {}) {
  const r = reports.getReport(reportId);
  if (!r) fail(404, 'Report not found');
  if (r.xeroInvoiceId) fail(409, `This report is already in Xero as bill ${r.xeroInvoiceId}`);
  if (r.status !== 'claimed') fail(409, 'Only a claimed case can be posted to Xero');
  if (!r.expenses.length) fail(400, 'This case has no receipts to post');
  const problems = postProblems(r);
  if (problems.length) fail(400, `Fix this before posting: ${problems.join('; ')}.`);

  const payload = await reportPayload(reportId, { withReceipts: false });
  const company = payload.company;
  const config  = users.getCompanyConfig(company.id);
  const tokenCache = require('./token-cache');
  const tenant = tokenCache.getPersistedTenants(company.id)[0] || null;
  if (!tenant && !dryRun) throw new Error('Xero is not connected. Connect the organisation in Settings first.');

  let accounts = [], taxRates = [];
  if (tenant) {
    try { accounts = await getAccounts(company.id, tenant.tenantId); } catch (err) { logger.warn('Chart of accounts unavailable; using the default account', { error: xeroErrMsg(err) }); }
    try { taxRates = await getTaxRates(company.id, tenant.tenantId); } catch (err) { logger.warn('Tax rates unavailable; lines go without a tax type', { error: xeroErrMsg(err) }); }
  }
  const bill = buildBill(payload, { accounts, defaultAccountCode: config.DEFAULT_ACCOUNT_CODE || null, taxRates });
  // Xero refuses a bill below zero, so advances above the claim cannot post.
  if (bill.total < 0) fail(400, `The advances are more than the claim, so the bill would be ${money(bill.total)}. Lower the advance on the case cover first.`);
  if (dryRun) return { dryRun: true, tenantId: tenant ? tenant.tenantId : null, tenantName: tenant ? tenant.tenantName : null, bill };

  // From here on a bill is going to be created, so take the claim first: two
  // clicks on Post used to make two draft bills for one report.
  if (!reports.claimForPost(reportId)) fail(409, 'This report is already being posted to Xero. Give it a moment and reload.');
  // One key per attempt: a reply lost on the way back, retried, returns the
  // same bill instead of making a second. A new attempt after a refusal gets
  // a new key, so a corrected case can still post.
  const attemptKey = `solv-${reportId}-${Date.now()}`;

  // Everything up to the bill existing either succeeds or releases the claim.
  // The token fetch used to sit outside this, so a failed refresh left the
  // case marked "being posted" for good and every later attempt refused.
  let created;
  let api;
  try {
    const { AccountingApi } = require('xero-node');
    const token = await tokenCache.forCompany(company.id).getValidToken(tenant.tenantId);
    api = new AccountingApi();
    api.accessToken = token;
    const contactID = await getOrCreateContact(company.id, tenant.tenantId, { vendorName: bill.contact.name, email: bill.contact.email, invoiceType: 'ACCPAY' });
    const res = await withRetry(() => api.createInvoices(tenant.tenantId, { invoices: [{ ...bill.invoice, contact: { contactID } }] }, undefined, undefined, attemptKey));
    created = res.body.invoices[0];
    if (!created || !created.invoiceID) throw new Error('Xero answered without a bill');
  } catch (err) {
    const msg = xeroErrMsg(err);
    reports.releasePost(reportId, msg);
    reports.addEvent(reportId, actor.id, 'xero_failed', msg);
    throw new Error(`Xero refused the bill: ${msg}`);
  }

  // The bill exists: record it now, before the attachments. It used to be
  // recorded only after every receipt was attached, so a restart part-way left
  // a bill in Xero, a case that did not know it, and a 'posting' marker that
  // refused every later attempt. If this process stops during the uploads the
  // case still knows its bill, and the note says to check the attachments.
  reports.setState(reportId, { xeroInvoiceId: created.invoiceID, xeroError: 'Receipts were still being attached when this was last checked. Check the bill in Xero.' });
  reports.addEvent(reportId, actor.id, 'posted', `Xero bill ${created.invoiceID}`);

  // Receipts, best-effort: a rejected attachment is noted, never a reason to
  // lose the bill that was just created.
  const warnings = [];
  // The same R1, R2… the printed report gives each receipt.
  const refs = require('../reports/expense-payload').receiptRefs(r.expenses);
  const seen = new Set();
  for (const e of r.expenses) {
    if (!e.receipt || seen.has(e.receipt.id)) continue;
    seen.add(e.receipt.id);
    const ref = refs.get(e.receipt.id);
    try {
      for (const a of await attachments.forReceipt(e.receipt, { ref })) {
        await withRetry(() => api.createInvoiceAttachmentByFileName(tenant.tenantId, created.invoiceID, a.name, Readable.from(a.buffer), false, `${created.invoiceID}-${a.name}`.slice(0, 128)));
      }
    } catch (err) {
      warnings.push(`${ref}: ${xeroErrMsg(err)}`);
      logger.warn('Receipt not attached to the Xero bill', { reportId, ref, error: xeroErrMsg(err) });
    }
  }

  // The status stays claimed: xero_invoice_id is what records the posting.
  reports.setState(reportId, { xeroError: warnings.length ? `Attachments: ${warnings.join('; ')}` : null });
  logger.info('Report posted to Xero', { reportId, number: r.number, invoiceID: created.invoiceID, lines: bill.invoice.lineItems.length, by: actor.id });
  return { dryRun: false, tenantId: tenant.tenantId, tenantName: tenant.tenantName, xeroInvoiceId: created.invoiceID, warnings, bill };
}

module.exports = { buildBill, postReport, postProblems, DUE_DAYS };
