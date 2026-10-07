const crypto = require('crypto');
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

// Pure: the bill as Xero will receive it, minus the contact id.
function buildBill(payload, { accounts = [], defaultAccountCode = null, advancesAccountCode = null, taxRates = [] } = {}) {
  const { company, report, owner = {}, lines = [], receipts = [] } = payload;
  const base = company.baseCurrency;
  const active = taxRates.filter(r => String(r.status || 'ACTIVE').toUpperCase() === 'ACTIVE' && r.canApplyToExpenses !== false);
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
    const wantsTax = !foreign && Number(l.tax) > 0;
    const gst = wantsTax ? purchaseTax(accountCode, accounts, active) : null;
    const taxed = !!gst;
    const taxType = taxed ? gst.taxType : wantsTax ? undefined : zeroType;
    // Send the tax the receipt actually printed. Left to itself Xero derives it
    // from the rate, which is only right when the receipt was taxed at exactly
    // the organisation's top rate.
    const taxAmount = taxed ? Number(l.baseTax ?? l.tax ?? 0) : undefined;
    return { description, quantity: 1, unitAmount: Number(l.baseAmount || 0), ...(accountCode ? { accountCode } : {}), ...(taxType ? { taxType } : {}),
             ...(taxAmount ? { taxAmount: Math.round(taxAmount * 100) / 100 } : {}) };
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

module.exports = { buildBill, postReport, postProblems, purchaseTax, idempotencyKey, DUE_DAYS };
