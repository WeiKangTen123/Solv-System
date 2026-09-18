const mockCreateInvoices = jest.fn();
const mockAttach = jest.fn().mockResolvedValue({});
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => ({ createInvoices: mockCreateInvoices, createInvoiceAttachmentByFileName: mockAttach })) }));
jest.mock('./token-cache', () => ({ forCompany: () => ({ getValidToken: async () => 'tok' }), getPersistedTenants: jest.fn(() => [{ tenantId: 't1', tenantName: 'Solv Pte Ltd' }]) }));
jest.mock('./contacts', () => ({ getOrCreateContact: jest.fn().mockResolvedValue('contact-1') }));
jest.mock('./category-account', () => ({
  ...jest.requireActual('./category-account'),
  getAccounts: jest.fn().mockResolvedValue([{ code: '494', name: 'Travel - International', type: 'EXPENSE', status: 'ACTIVE' }, { code: '420', name: 'Entertainment', type: 'EXPENSE', status: 'ACTIVE' }, { code: '429', name: 'General Expenses', type: 'EXPENSE', status: 'ACTIVE' }]),
  getTaxRates: jest.fn().mockResolvedValue([{ name: 'GST on Expenses', taxType: 'INPUT', status: 'ACTIVE', displayTaxRate: 9, canApplyToExpenses: true }, { name: 'No Tax', taxType: 'NONE', status: 'ACTIVE', displayTaxRate: 0, canApplyToExpenses: true }]),
}));
jest.mock('./attachments', () => ({ forReceipt: jest.fn().mockResolvedValue([{ name: 'R1.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF') }]) }));

const payload = {
  company: { id: 'c1', name: 'Solv Pte Ltd', baseCurrency: 'SGD', timezone: 'Asia/Singapore' },
  report: { number: 'EXP-2026-0007', title: 'India trip', purpose: 'Client visits', status: 'approved', approvedAt: '2026-09-10T06:02:00Z', submittedAt: '2026-09-05T02:00:00Z' },
  owner: { name: 'Elaine Xin Yu Khoo', email: 'elaine@solv.sg' },
  lines: [
    { ref: 'R1', date: '2026-09-04', merchant: 'Courtyard Pune', purpose: 'Site visit', category: 'Lodging', currency: 'INR', amount: 43131.36, fxRate: 0.01341, baseAmount: 578.39, onBehalfOf: null, tax: 13452.52 },
    { ref: 'R1', date: '2026-09-04', merchant: 'Courtyard Pune', purpose: 'Site visit', category: 'Lodging', currency: 'INR', amount: 36713.34, fxRate: 0.01341, baseAmount: 492.33, onBehalfOf: 'Tan Suan Kuan', tax: 13452.52 },
    { ref: 'R2', date: '2026-09-02', merchant: 'Grab', purpose: null, category: 'Air & Transport', currency: 'SGD', amount: 18.4, fxRate: 1, baseAmount: 18.4, onBehalfOf: null, tax: 1.52 },
    { ref: 'R3', date: '2026-09-03', merchant: 'Clinic', purpose: null, category: 'Medical/Dental', currency: 'SGD', amount: 40, fxRate: 1, baseAmount: 40, onBehalfOf: null, tax: 0 },
  ],
  receipts: [{ ref: 'R1', title: 'Courtyard', pages: [] }, { ref: 'R2', title: 'Grab', pages: [] }, { ref: 'R3', title: 'Clinic', pages: [] }],
};

describe('xero/bills — buildBill', () => {
  const { buildBill } = require('./bills');
  const chart = [{ code: '494', name: 'Travel - International', type: 'EXPENSE', status: 'ACTIVE' }, { code: '493', name: 'Travel - National', type: 'EXPENSE', status: 'ACTIVE' }];
  const rates = [{ name: 'GST on Expenses', taxType: 'INPUT', status: 'ACTIVE', displayTaxRate: 9, canApplyToExpenses: true }, { name: 'No Tax', taxType: 'NONE', status: 'ACTIVE', displayTaxRate: 0, canApplyToExpenses: true }];

  test('one SGD draft bill payable to the claimant, one line per report line at its base amount', () => {
    const b = buildBill(payload, { accounts: chart, defaultAccountCode: '429', taxRates: rates });
    expect(b.contact).toEqual({ name: 'Elaine Xin Yu Khoo', email: 'elaine@solv.sg' });
    expect(b.invoice).toMatchObject({ type: 'ACCPAY', status: 'DRAFT', currencyCode: 'SGD', lineAmountTypes: 'Inclusive', invoiceNumber: 'EXP-2026-0007', reference: 'India trip', date: '2026-09-10', dueDate: '2026-09-17' });
    expect(b.invoice.lineItems.map(l => l.unitAmount)).toEqual([578.39, 492.33, 18.4, 40]);
    expect(b.total).toBe(1129.12);
    expect(b.invoice.lineItems[0].description).toBe('4 Sep 2026 · Courtyard Pune · Lodging · Site visit · INR 43,131.36 × 0.01341');
    expect(b.invoice.lineItems[1].description).toContain('on behalf of Tan Suan Kuan');
    expect(b.invoice.lineItems.map(l => l.accountCode)).toEqual(['494', '494', '493', '429']);
    // Foreign tax is never local input tax; a local receipt with GST is; a local receipt without tax is not.
    expect(b.invoice.lineItems.map(l => l.taxType)).toEqual(['NONE', 'NONE', 'INPUT', 'NONE']);
    expect(b.attachments).toEqual(['R1', 'R2', 'R3']);
  });

  test('with no chart and no default, lines go without an account code and Xero decides', () => {
    const b = buildBill(payload, {});
    expect(b.invoice.lineItems.every(l => l.accountCode === undefined)).toBe(true);
    expect(b.invoice.lineItems.every(l => l.taxType === 'NONE')).toBe(true);
  });
});

describe('xero/bills — postReport', () => {
  let users, store, reports, wf, bills, admin, mgr, fin, emp, report;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    mockCreateInvoices.mockReset(); mockAttach.mockClear();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports'); wf = require('../reports/workflow'); bills = require('./bills');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    mgr = await users.createUser({ email: 'm@solv.sg', password: 'password123', companyId: admin.companyId, role: 'manager' });
    fin = await users.createUser({ email: 'f@solv.sg', password: 'password123', companyId: admin.companyId, role: 'finance' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, managerId: mgr.id, name: 'Elaine' });
    users.saveCompanyConfig(admin.companyId, { DEFAULT_ACCOUNT_CODE: '429' });
    const rc = store.createReceipt({ companyId: admin.companyId, userId: emp.id, file: 'r.pdf', mime: 'application/pdf', sha256: 'h' });
    const e = store.createExpense({ companyId: admin.companyId, userId: emp.id, receiptId: rc.id, status: 'reviewed', merchant: 'Courtyard', currency: 'INR', total: 100, receiptDate: '2026-09-04',
      lines: [{ category: 'Lodging', amount: 100, baseAmount: 1.34, fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }] });
    report = reports.createReport({ companyId: admin.companyId, userId: emp.id, title: 'T' });
    reports.addExpense(report.id, e.id);
  });

  test('refuses a report that is not approved', async () => {
    await expect(bills.postReport(report.id, fin)).rejects.toThrow(/approved/);
  });

  test('a dry run builds the bill and sends nothing', async () => {
    wf.submit(report.id, emp); wf.approve(report.id, mgr);
    const out = await bills.postReport(report.id, fin, { dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.tenantName).toBe('Solv Pte Ltd');
    expect(out.bill.invoice.lineItems).toHaveLength(1);
    expect(out.bill.invoice.lineItems[0]).toMatchObject({ unitAmount: 1.34, accountCode: '494' });
    expect(mockCreateInvoices).not.toHaveBeenCalled();
    expect(reports.getReport(report.id).status).toBe('approved');
  });

  test('posts the bill, attaches the receipt, records the Xero id and an event', async () => {
    wf.submit(report.id, emp); wf.approve(report.id, mgr);
    mockCreateInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-bill-1' }] } });
    const out = await bills.postReport(report.id, fin);
    expect(out.xeroInvoiceId).toBe('xero-bill-1');
    const sent = mockCreateInvoices.mock.calls[0][1].invoices[0];
    expect(sent).toMatchObject({ type: 'ACCPAY', status: 'DRAFT', contact: { contactID: 'contact-1' }, currencyCode: 'SGD' });
    expect(mockAttach).toHaveBeenCalledTimes(1);
    expect(mockAttach.mock.calls[0].slice(0, 3)).toEqual(['t1', 'xero-bill-1', 'R1.pdf']);
    const after = reports.getReport(report.id);
    expect(after).toMatchObject({ status: 'posted', xeroInvoiceId: 'xero-bill-1', xeroError: null });
    expect(after.events.at(-1)).toMatchObject({ action: 'posted' });
    await expect(bills.postReport(report.id, fin)).rejects.toThrow(/already in Xero/);
  });

  test("Xero's validation error is stored on the report and surfaced", async () => {
    wf.submit(report.id, emp); wf.approve(report.id, mgr);
    mockCreateInvoices.mockRejectedValue(new Error(JSON.stringify({ response: { statusCode: 400, body: { Elements: [{ ValidationErrors: [{ Message: 'Account code 494 is not valid' }] }] } } })));
    await expect(bills.postReport(report.id, fin)).rejects.toThrow(/Account code 494/);
    const after = reports.getReport(report.id);
    expect(after.status).toBe('approved');
    expect(after.xeroError).toMatch(/Account code 494/);
    expect(after.events.at(-1).action).toBe('xero_failed');
  });
});
