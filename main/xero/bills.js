const { Readable } = require('stream');
const reports = require('../store/reports');
const users   = require('../utils/users');
const { reportPayload } = require('../reports/expense-payload');
const { getOrCreateContact } = require('./contacts');
const { accountForCategory, getAccounts, getTaxRates } = require('./category-account');
const attachments = require('./attachments');
const { withRetry, xeroErrMsg } = require('./xero-utils');
const { _fmtDate: fmtDate } = require('../reports/expense-doc');
const logger  = require('../utils/logger');

// An approved report becomes ONE draft bill in Xero, payable to the claimant,
// in the company's base currency: one line per report line at its base
// amount, so the bill equals the printed report to the cent. The original
// currency, amount and rate ride in each line's description.
const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
      foreign ? `${l.currency} ${money(l.amount)} × ${l.fxRate}` : null,
    ].filter(Boolean).join(' · ').slice(0, 4000);
    // Local GST only where the receipt shows tax in the base currency; foreign tax is never input tax.
    const taxType = !foreign && Number(l.tax) > 0 && gst ? gst.taxType : zeroType;
    return { description, quantity: 1, unitAmount: Number(l.baseAmount || 0), ...(accountCode ? { accountCode } : {}), taxType };
  });
  const date = (report.approvedAt || report.submittedAt || new Date().toISOString()).slice(0, 10);
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

async function postReport(reportId, actor, { dryRun = false } = {}) {
  const r = reports.getReport(reportId);
  if (!r) throw new Error('Report not found');
  if (r.xeroInvoiceId) throw new Error(`This report is already in Xero as bill ${r.xeroInvoiceId}`);
  if (!['approved', 'paid'].includes(r.status)) throw new Error('Only an approved report can be posted to Xero');

  const payload = await reportPayload(reportId, { withReceipts: false });
  const company = payload.company;
  const config  = users.getCompanyConfig(company.id);
  const tokenCache = require('../utils/token-cache');
  const tenant = tokenCache.getPersistedTenants(company.id)[0] || null;
  if (!tenant && !dryRun) throw new Error('Xero is not connected. Connect the organisation in Settings first.');

  let accounts = [], taxRates = [];
  if (tenant) {
    try { accounts = await getAccounts(company.id, tenant.tenantId); } catch (err) { logger.warn('Chart of accounts unavailable; using the default account', { error: xeroErrMsg(err) }); }
    try { taxRates = await getTaxRates(company.id, tenant.tenantId); } catch (err) { logger.warn('Tax rates unavailable; lines go without a tax type', { error: xeroErrMsg(err) }); }
  }
  const bill = buildBill(payload, { accounts, defaultAccountCode: config.DEFAULT_ACCOUNT_CODE || null, taxRates });
  if (dryRun) return { dryRun: true, tenantId: tenant ? tenant.tenantId : null, tenantName: tenant ? tenant.tenantName : null, bill };

  const { AccountingApi } = require('xero-node');
  const token = await tokenCache.forCompany(company.id).getValidToken(tenant.tenantId);
  const api = new AccountingApi();
  api.accessToken = token;

  const contactID = await getOrCreateContact(company.id, tenant.tenantId, { vendorName: bill.contact.name, email: bill.contact.email, invoiceType: 'ACCPAY' });
  let created;
  try {
    const res = await withRetry(() => api.createInvoices(tenant.tenantId, { invoices: [{ ...bill.invoice, contact: { contactID } }] }));
    created = res.body.invoices[0];
  } catch (err) {
    const msg = xeroErrMsg(err);
    reports.setState(reportId, { xeroError: msg });
    reports.addEvent(reportId, actor.id, 'xero_failed', msg);
    throw new Error(`Xero refused the bill: ${msg}`);
  }

  // Receipts, best-effort: a rejected attachment is noted, never a reason to
  // lose the bill that was just created.
  const warnings = [];
  const seen = new Set();
  let n = 0;
  for (const e of r.expenses) {
    if (!e.receipt || seen.has(e.receipt.id)) continue;
    seen.add(e.receipt.id);
    const ref = `R${++n}`;
    try {
      for (const a of await attachments.forReceipt(e.receipt, { ref })) {
        await withRetry(() => api.createInvoiceAttachmentByFileName(tenant.tenantId, created.invoiceID, a.name, Readable.from(a.buffer), false));
      }
    } catch (err) {
      warnings.push(`${ref}: ${xeroErrMsg(err)}`);
      logger.warn('Receipt not attached to the Xero bill', { reportId, ref, error: xeroErrMsg(err) });
    }
  }

  reports.setState(reportId, { status: r.status === 'paid' ? 'paid' : 'posted', xeroInvoiceId: created.invoiceID, xeroError: warnings.length ? `Attachments: ${warnings.join('; ')}` : null });
  reports.addEvent(reportId, actor.id, 'posted', `Xero bill ${created.invoiceID}`);
  logger.info('Report posted to Xero', { reportId, number: r.number, invoiceID: created.invoiceID, lines: bill.invoice.lineItems.length, by: actor.email });
  return { dryRun: false, tenantId: tenant.tenantId, tenantName: tenant.tenantName, xeroInvoiceId: created.invoiceID, warnings, bill };
}

module.exports = { buildBill, postReport, DUE_DAYS };
