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
jest.mock('./attachments', () => ({
  forReceipt: jest.fn().mockResolvedValue([{ name: 'R1.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF') }]),
  // The real case PDF, made from the case, unless a test says otherwise.
  casePdfs: jest.fn((...args) => jest.requireActual('./attachments').casePdfs(...args)),
  MAX_FILES: 10, MAX_BYTES: 3 * 1024 * 1024,
}));

const payload = {
  company: { id: 'c1', name: 'Solv Pte Ltd', baseCurrency: 'SGD', timezone: 'Asia/Singapore' },
  report: { number: 'EXP-2026-0007', title: 'India trip', purpose: 'Client visits', status: 'claimed', claimedAt: '2026-09-10T06:02:00Z' },
  owner: { name: 'Aisha Mei Ling Rahman', email: 'aisha@solv.sg' },
  lines: [
    { ref: 'R1', date: '2026-09-04', merchant: 'Courtyard Pune', purpose: 'Site visit', category: 'Lodging', currency: 'INR', amount: 43131.36, fxRate: 0.01341, baseAmount: 578.39, onBehalfOf: null, tax: 13452.52 },
    { ref: 'R1', date: '2026-09-04', merchant: 'Courtyard Pune', purpose: 'Site visit', category: 'Lodging', currency: 'INR', amount: 36713.34, fxRate: 0.01341, baseAmount: 492.33, onBehalfOf: 'Lim Wei Jie', tax: 13452.52 },
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
    expect(b.contact).toEqual({ name: 'Aisha Mei Ling Rahman', email: 'aisha@solv.sg' });
    expect(b.invoice).toMatchObject({ type: 'ACCPAY', status: 'DRAFT', currencyCode: 'SGD', lineAmountTypes: 'Inclusive', invoiceNumber: 'EXP-2026-0007', reference: 'India trip', date: '2026-09-10', dueDate: '2026-09-17' });
    expect(b.invoice.lineItems.map(l => l.unitAmount)).toEqual([578.39, 492.33, 18.4, 40]);
    expect(b.total).toBe(1129.12);
    expect(b.invoice.lineItems[0].description).toBe('4 Sep 2026 · Courtyard Pune · Lodging · Site visit · INR 43,131.36 × 0.01341');
    expect(b.invoice.lineItems[1].description).toContain('on behalf of Lim Wei Jie');
    expect(b.invoice.lineItems.map(l => l.accountCode)).toEqual(['494', '494', '493', '429']);
    // Foreign tax is never local input tax; a local receipt with GST is; a local receipt without tax is not.
    expect(b.invoice.lineItems.map(l => l.taxType)).toEqual(['NONE', 'NONE', 'INPUT', 'NONE']);
    expect(b.attachments).toEqual(['R1', 'R2', 'R3']);
  });

  test('with no chart and no default, lines go without an account code and Xero decides', () => {
    const b = buildBill(payload, {});
    expect(b.invoice.lineItems.every(l => l.accountCode === undefined)).toBe(true);
    // With no tax rates to choose from, a taxed local line carries no tax type,
    // so Xero applies the account's own; the rest say NONE.
    expect(b.invoice.lineItems.map(l => l.taxType)).toEqual(['NONE', 'NONE', undefined, 'NONE']);
  });

  // Several 9% purchase types exist in a Singapore organisation. "The highest
  // rate" picked whichever Xero listed first, which could be blocked input tax.
  test("a taxed line takes its account's own tax type, else standard-rated purchases, never blocked or imports by default", () => {
    const { purchaseTax } = require('./bills');
    const sg = [
      { name: 'Blocked Input Tax', taxType: 'BLINPUT3', status: 'ACTIVE', displayTaxRate: 9 },
      { name: 'Imports', taxType: 'IMINPUT2', status: 'ACTIVE', displayTaxRate: 9 },
      { name: 'Standard-Rated Purchases', taxType: 'TXINPUT9', status: 'ACTIVE', displayTaxRate: 9 },
      { name: 'No Tax', taxType: 'NONE', status: 'ACTIVE', displayTaxRate: 0 },
    ];
    expect(purchaseTax(null, [], sg).taxType).toBe('TXINPUT9');
    expect(purchaseTax('420', [{ code: '420', taxType: 'IMINPUT2' }], sg).taxType).toBe('IMINPUT2');
    expect(purchaseTax(null, [], sg.filter(r => !/Standard/.test(r.name)))).toBeNull();   // no right guess among the special kinds
    expect(purchaseTax(null, [], [{ name: 'No Tax', taxType: 'NONE', displayTaxRate: 0 }])).toBeNull();
  });

  test('an advance is cleared against the advances account, not the expense account', () => {
    const b = buildBill({ ...payload, report: { ...payload.report, advances: 100 } }, { accounts: chart, defaultAccountCode: '429', advancesAccountCode: '610', taxRates: rates });
    const advance = b.invoice.lineItems.at(-1);
    expect(advance).toMatchObject({ unitAmount: -100, accountCode: '610', taxType: 'NONE' });
    expect(b.total).toBe(1029.12);
  });

  test('the same bill always has the same idempotency key, and a changed one a new key', () => {
    const { idempotencyKey } = require('./bills');
    const a = buildBill(payload, { accounts: chart, taxRates: rates });
    const same = buildBill(payload, { accounts: chart, taxRates: rates });
    const changed = buildBill({ ...payload, lines: payload.lines.slice(1) }, { accounts: chart, taxRates: rates });
    expect(idempotencyKey('r1', a)).toBe(idempotencyKey('r1', same));
    expect(idempotencyKey('r1', a)).not.toBe(idempotencyKey('r1', changed));
    expect(idempotencyKey('r1', a)).toMatch(/^solv-r1-[0-9a-f]{24}$/);
  });
});

// Receipts kept as printed carry each line's taxes (line.taxes): the bill
// codes each tax at its own rate, on the part of the line it was charged on.
describe('xero/bills — tax as printed', () => {
  const { buildBill, taxForRate } = require('./bills');
  // A Malaysian organisation's purchase rates, and a Singapore one's.
  const MY = [
    { name: 'Service Tax 6%', taxType: 'TAX006', status: 'ACTIVE', displayTaxRate: 6, canApplyToExpenses: true },
    { name: 'Service Tax 8%', taxType: 'TAX008', status: 'ACTIVE', displayTaxRate: 8, canApplyToExpenses: true },
    { name: 'Imported Service Tax 8%', taxType: 'TAX018', status: 'ACTIVE', displayTaxRate: 8, canApplyToExpenses: true },
    { name: 'Sales Tax 5%', taxType: 'TAX005', status: 'ACTIVE', displayTaxRate: 5, canApplyToExpenses: true },
    { name: 'Sales Tax 10%', taxType: 'TAX010', status: 'ACTIVE', displayTaxRate: 10, canApplyToExpenses: true },
    { name: 'Tax Exempt', taxType: 'NONE', status: 'ACTIVE', displayTaxRate: 0, canApplyToExpenses: true },
  ];
  const SG = [
    { name: 'Blocked Input Tax 9%', taxType: 'BLINPUT3', status: 'ACTIVE', displayTaxRate: 9, canApplyToExpenses: true },
    { name: 'Imports', taxType: 'IMINPUT2', status: 'ACTIVE', displayTaxRate: 9, canApplyToExpenses: true },
    { name: 'Standard-Rated Purchases', taxType: 'TXINPUT9', status: 'ACTIVE', displayTaxRate: 9, canApplyToExpenses: true },
    { name: 'Standard-Rated Purchases 8%', taxType: 'TXINPUT8', status: 'DELETED', displayTaxRate: 8, canApplyToExpenses: true },
    { name: 'No Tax', taxType: 'NONE', status: 'ACTIVE', displayTaxRate: 0, canApplyToExpenses: true },
  ];
  const tax = (label, rate, amount, gross, extra = {}) => ({ label, rate, amount, included: false, gross, ...extra });
  const line = (extra) => ({ ref: 'R1', date: '2026-10-12', merchant: 'Hotel Stripes Kuala Lumpur', purpose: 'Client visit', fxRate: 1, fxSource: 'base', onBehalfOf: null, ...extra });
  const myCase = lines => ({ ...payload, company: { ...payload.company, baseCurrency: 'MYR', timezone: 'Asia/Kuala_Lumpur' }, lines, receipts: [{ ref: 'R1', title: 'Hotel', pages: [] }] });
  const sgCase = lines => ({ ...payload, lines, receipts: [{ ref: 'R1', title: 'Toast Box', pages: [] }] });
  const shape = b => b.invoice.lineItems.map(l => [l.unitAmount, l.taxType, l.taxAmount, l.description.split(' · ').at(-1)]);

  test('a KL hotel: the room at Service Tax 8% with the tourism tax on a line of its own, the breakfast at SST 6%', () => {
    const b = buildBill(myCase([
      line({ category: 'Lodging', currency: 'MYR', amount: 342.64, baseAmount: 342.64, taxes: [tax('Service Tax', 8, 24.64, 332.64)] }),
      line({ category: 'Meals', currency: 'MYR', amount: 99.11, baseAmount: 99.11, taxes: [tax('SST', 6, 5.61, 99.11)] }),
    ]), { taxRates: MY });
    expect(shape(b)).toEqual([
      [332.64, 'TAX008', 24.64, 'Service Tax 8%'],
      [10, 'NONE', undefined, 'not taxed'],
      [99.11, 'TAX006', 5.61, 'SST 6%'],
    ]);
    expect(b.invoice.lineAmountTypes).toBe('Inclusive');
    expect(b.total).toBe(441.75);
    expect(b.invoice.lineItems[0].description).toBe('12 Oct 2026 · Hotel Stripes Kuala Lumpur · Lodging · Client visit · Service Tax 8%');
  });

  test("the nasi kandar shop's 5-sen rounding stays inside the taxed line, a colleague's share is its own line", () => {
    const b = buildBill(myCase([
      line({ merchant: 'Restoran Nasi Kandar Pelita', category: 'Meals', currency: 'MYR', amount: 21.32, baseAmount: 21.32, taxes: [tax('SST', 6, 1.21, 21.34)] }),
      line({ merchant: 'Restoran Nasi Kandar Pelita', category: 'Meals', currency: 'MYR', amount: 6.53, baseAmount: 6.53, onBehalfOf: 'Jane Tan', taxes: [tax('SST', 6, 0.37, 6.53)] }),
    ]), { taxRates: MY });
    expect(shape(b)).toEqual([[21.32, 'TAX006', 1.21, 'SST 6%'], [6.53, 'TAX006', 0.37, 'SST 6%']]);
    expect(b.invoice.lineItems[1].description).toContain('on behalf of Jane Tan');
    expect(b.total).toBe(27.85);
  });

  test('CGST and SGST charged on the same part are one line at their combined rate', () => {
    const IN = [{ name: 'GST 18%', taxType: 'GST18', status: 'ACTIVE', displayTaxRate: 18 }, { name: 'GST 9%', taxType: 'GST9', status: 'ACTIVE', displayTaxRate: 9 }, { name: 'No Tax', taxType: 'NONE', status: 'ACTIVE', displayTaxRate: 0 }];
    const b = buildBill({ ...payload, company: { ...payload.company, baseCurrency: 'INR' }, lines: [
      line({ merchant: 'JW Marriott Mumbai Sahar', category: 'Lodging', currency: 'INR', amount: 22420, baseAmount: 22420, taxes: [tax('CGST', 9, 1710, 22420), tax('SGST', 9, 1710, 22420)] }),
    ] }, { taxRates: IN });
    expect(shape(b)).toEqual([[22420, 'GST18', 3420, 'CGST 9% + SGST 9%']]);
    // Named by the rows they were charged on, the pair is still one line at 18%.
    const named = buildBill({ ...payload, company: { ...payload.company, baseCurrency: 'INR' }, lines: [
      line({ merchant: 'JW Marriott Mumbai Sahar', category: 'Lodging', currency: 'INR', amount: 22420, baseAmount: 22420, taxes: [tax('CGST', 9, 1710, 22420, { basis: '0' }), tax('SGST', 9, 1710, 22420, { basis: '0' })] }),
    ] }, { taxRates: IN });
    expect(shape(named)).toEqual([[22420, 'GST18', 3420, 'CGST 9% + SGST 9%']]);
  });

  // Two nights, each with its own Service Tax 8% on its own 332.64. Grouped by
  // their equal amounts they were one 332.64 at 16%, coded as Sales Tax 10%,
  // and the second night went "not taxed".
  test('two nights each with their own tax are a bill line each, by the rows they were on or, without them, by their amounts', () => {
    const nights = basis => line({ merchant: 'Hotel Seri Bukit', category: 'Lodging', currency: 'MYR', amount: 685.28, baseAmount: 685.28, taxes: [
      tax('20/10 Service Tax', 8, 24.64, 332.64, basis ? { basis: '0,1' } : {}), tax('21/10 Service Tax', 8, 24.64, 332.64, basis ? { basis: '3,4' } : {})] });
    for (const basis of [true, false]) {
      const b = buildBill(myCase([nights(basis)]), { taxRates: MY });
      expect(shape(b)).toEqual([
        [332.64, 'TAX008', 24.64, '20/10 Service Tax 8%'],
        [332.64, 'TAX008', 24.64, '21/10 Service Tax 8%'],
        [20, 'NONE', undefined, 'not taxed'],
      ]);
      expect(b.total).toBe(685.28);
    }
    // Singapore: two nights at 200.00, GST included in each.
    const sg = basis => line({ merchant: 'Hotel Orchard', category: 'Lodging', currency: 'SGD', amount: 400, baseAmount: 400, taxes: [
      tax('12/10 GST', 9, 16.51, 200, { included: true, ...(basis ? { basis: '0' } : {}) }), tax('13/10 GST', 9, 16.51, 200, { included: true, ...(basis ? { basis: '1' } : {}) })] });
    for (const basis of [true, false]) {
      expect(shape(buildBill(sgCase([sg(basis)]), { taxRates: SG }))).toEqual([[200, 'TXINPUT9', 16.51, '12/10 GST 9%'], [200, 'TXINPUT9', 16.51, '13/10 GST 9%']]);
    }
  });

  // Taxes at different rates on one part: each its own line, worked back from
  // its amount and rate. Summed they were 14%, coded as Sales Tax 10%.
  test('a 6% and an 8% read on the same items are a line each, worked back from the tax; the rest is not taxed', () => {
    // 395.25 is what claimLines gives the two together, the service charges
    // left out: a guess, so the worked-back amounts are held only to the line.
    for (const gross of [431.75, 395.25]) {
      const b = buildBill(myCase([line({ merchant: 'Hotel Stripes Kuala Lumpur', category: 'Lodging', currency: 'MYR', amount: 441.75, baseAmount: 441.75, taxes: [
        tax('SST', 6, 5.61, gross, { basis: 'all' }), tax('Service Tax', 8, 24.64, gross, { basis: 'all' })] })]), { taxRates: MY });
      expect(shape(b)).toEqual([[99.11, 'TAX006', 5.61, 'SST 6%'], [332.64, 'TAX008', 24.64, 'Service Tax 8%'], [10, 'NONE', undefined, 'not taxed']]);
      expect(b.total).toBe(441.75);
    }
  });

  test('a Berlin hotel\'s 7% on the room and 19% on breakfast, both included, are a line each and never more than the bill', () => {
    const DE = [{ name: 'Vorsteuer 7%', taxType: 'V7', status: 'ACTIVE', displayTaxRate: 7 }, { name: 'Vorsteuer 19%', taxType: 'V19', status: 'ACTIVE', displayTaxRate: 19 }, { name: 'Keine Steuer', taxType: 'NONE', status: 'ACTIVE', displayTaxRate: 0 }];
    const b = buildBill({ ...payload, company: { ...payload.company, baseCurrency: 'EUR' }, lines: [
      line({ merchant: 'Hotel Kastanie Berlin', category: 'Lodging', currency: 'EUR', amount: 280, baseAmount: 280, taxes: [
        tax('MwSt', 7, 15.05, 280, { included: true }), tax('MwSt', 19, 7.98, 280, { included: true })] }),
    ] }, { taxRates: DE });
    const lines = shape(b);
    expect(lines.map(l => [l[1], l[2], l[3]])).toEqual([['V7', 15.05, 'MwSt 7%'], ['V19', 7.98, 'MwSt 19%']]);
    // 230.05 and 49.98 worked back, 3 cents over the bill: held to it.
    expect(lines.map(l => l[0])).toEqual([230.03, 49.97]);
    expect(b.total).toBe(280);
  });

  test('a part with a tax of no printed rate stays one line, as before', () => {
    const b = buildBill(myCase([line({ category: 'Meals', currency: 'MYR', amount: 50, baseAmount: 50, taxes: [tax('SST', 6, 2.5, 50, { basis: 'x' }), tax('Levy', null, 1, 50, { basis: 'x' })] })]), { taxRates: MY });
    expect(shape(b)).toEqual([[50, 'TAX010', 3.5, 'SST 6% + Levy']]);
  });

  test('Singapore: GST 9% as printed, included or worked out, to standard-rated purchases; a rate the organisation no longer has, as before', () => {
    const b = buildBill(sgCase([
      line({ merchant: 'Toast Box', category: 'Meals', currency: 'SGD', amount: 21.8, baseAmount: 21.8, taxes: [tax('GST', 9, 1.8, 21.8, { included: true, worked: true })] }),
      // A 2023 receipt at 7%: no 7% type, so today's choice, with the tax it printed.
      line({ merchant: 'Kopitiam', category: 'Meals', currency: 'SGD', amount: 10.7, baseAmount: 10.7, taxes: [tax('GST', 7, 0.7, 10.7, { included: true })] }),
      // No tax printed, and a receipt from before: as they always were.
      line({ merchant: 'Grab', category: 'Air & Transport', currency: 'SGD', amount: 18.4, baseAmount: 18.4, taxes: [] }),
      line({ merchant: 'Old', category: 'Meals', currency: 'SGD', amount: 50, baseAmount: 50, taxes: null, tax: 4.13, baseTax: 4.13 }),
    ]), { taxRates: SG });
    expect(shape(b)).toEqual([
      [21.8, 'TXINPUT9', 1.8, 'GST 9%'],
      [10.7, 'TXINPUT9', 0.7, 'GST 7%'],
      [18.4, 'NONE', undefined, 'Client visit'],
      [50, 'TXINPUT9', 4.13, 'Client visit'],
    ]);
  });

  test('a foreign receipt kept as printed stays one line on the zero type: its tax is not input tax here', () => {
    const b = buildBill(sgCase([
      line({ category: 'Lodging', currency: 'MYR', amount: 342.64, fxRate: 0.3049, baseAmount: 104.47, taxes: [tax('Service Tax', 8, 24.64, 332.64)], tax: 24.64, baseTax: 7.51 }),
    ]), { taxRates: SG });
    expect(shape(b)).toEqual([[104.47, 'NONE', undefined, 'MYR 342.64 × 0.3049']]);
  });

  test('taxes that do not say what they were charged on go as before; a part beyond the rounding is its own line, either way', () => {
    const noGross = buildBill(myCase([line({ category: 'Lodging', currency: 'MYR', amount: 100, baseAmount: 100, taxes: [tax('SST', 6, 5.66, null)], tax: 5.66, baseTax: 5.66 })]), { taxRates: MY });
    // Today's choice: the highest rate that is not a special kind.
    expect(shape(noGross)).toEqual([[100, 'TAX010', 5.66, 'Client visit']]);
    // A voucher off the whole bill after the tax: the taxed part is more than the line.
    const voucher = buildBill(myCase([line({ category: 'Meals', currency: 'MYR', amount: 90, baseAmount: 90, taxes: [tax('SST', 6, 5.66, 100)] })]), { taxRates: MY });
    expect(shape(voucher)).toEqual([[100, 'TAX006', 5.66, 'SST 6%'], [-10, 'NONE', undefined, 'not taxed']]);
    expect(voucher.total).toBe(90);
  });

  test('the tax type for a rate: the account\'s own, then one named like the tax, then standard-rated, never a special kind', () => {
    expect(taxForRate(8, ['Service Tax'], null, [], MY).taxType).toBe('TAX008');
    expect(taxForRate(6, ['SST'], null, [], MY).taxType).toBe('TAX006');
    expect(taxForRate(8, ['Service Tax'], '420', [{ code: '420', taxType: 'TAX018' }], MY).taxType).toBe('TAX018');
    expect(taxForRate(9, ['GST'], null, [], SG.filter(r => r.status === 'ACTIVE')).taxType).toBe('TXINPUT9');
    expect(taxForRate(9, ['GST'], null, [], SG.filter(r => /Blocked|Imports/.test(r.name)))).toBeNull();
    expect(taxForRate(7, ['GST'], null, [], SG)).toBeNull();
    expect(taxForRate(null, ['VAT'], null, [], SG)).toBeNull();
  });
});

describe('xero/bills — postReport', () => {
  let users, store, reports, wf, bills, admin, emp, report;
  beforeEach(async () => {
    jest.resetModules(); require('../db/migrate').run();
    mockCreateInvoices.mockReset(); mockAttach.mockClear();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports'); wf = require('../reports/workflow'); bills = require('./bills');
    admin = await users.createUser({ email: 'a@solv.sg', password: 'password123' });
    emp = await users.createUser({ email: 'e@solv.sg', password: 'password123', companyId: admin.companyId, name: 'Aisha' });
    users.saveCompanyConfig(admin.companyId, { DEFAULT_ACCOUNT_CODE: '429' });
    const rc = store.createReceipt({ companyId: admin.companyId, userId: emp.id, file: 'r.pdf', mime: 'application/pdf', sha256: 'h' });
    const e = store.createExpense({ companyId: admin.companyId, userId: emp.id, receiptId: rc.id, status: 'reviewed', merchant: 'Courtyard', currency: 'INR', total: 100, receiptDate: '2026-09-04',
      lines: [{ category: 'Lodging', amount: 100, baseAmount: 1.34, fxRate: 0.01341, fxRateDate: '2026-09-04', fxSource: 'frankfurter', fxFetchedAt: 'x' }] });
    report = reports.createReport({ companyId: admin.companyId, userId: emp.id, title: 'T' });
    reports.addExpense(report.id, e.id);
  });

  test('refuses a case that has not been claimed', async () => {
    await expect(bills.postReport(report.id, admin)).rejects.toThrow(/claimed/);
  });

  test('a dry run builds the bill and sends nothing', async () => {
    wf.markClaimed(report.id, emp);
    const out = await bills.postReport(report.id, admin, { dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.tenantName).toBe('Solv Pte Ltd');
    expect(out.bill.invoice.lineItems).toHaveLength(1);
    expect(out.bill.invoice.lineItems[0]).toMatchObject({ unitAmount: 1.34, accountCode: '494' });
    expect(mockCreateInvoices).not.toHaveBeenCalled();
    expect(reports.getReport(report.id).status).toBe('claimed');
  });

  // From the store, through the payload, to the bill: a Singapore receipt
  // kept as printed, its GST worked out because it prints only "includes GST".
  test('a receipt kept as printed posts its tax as printed, from the record the store keeps', async () => {
    const row = (kind, label, amount, extra = {}) => ({ kind, label, qty: null, unitPrice: null, amount, rate: null, included: false, worked: false, category: null, onBehalfOf: null, taxRate: null, on: null, ...extra });
    const e = store.createExpense({ companyId: admin.companyId, userId: emp.id, status: 'reviewed', merchant: 'Toast Box', currency: 'SGD', total: 21.8, tax: 1.8, receiptDate: '2026-09-05', category: 'Meals',
      printed: { v: 1, subtotal: null, total: 21.8, rows: [row('item', 'Kaya toast set', 21.8, { qty: 2, category: 'Meals' }), row('tax', 'GST', 1.8, { rate: 9, included: true, worked: true })] } });
    require('../receipts/edit').linesFromRecord(e.id);
    const l = store.getExpense(e.id).lines[0];
    store.updateLine(l.id, { fxRate: 1, fxRateDate: '2026-09-05', fxSource: 'base', baseAmount: 21.8 });
    reports.addExpense(report.id, e.id);
    wf.markClaimed(report.id, emp);
    const out = await bills.postReport(report.id, admin, { dryRun: true });
    expect(out.bill.invoice.lineItems[1]).toMatchObject({ unitAmount: 21.8, taxType: 'INPUT', taxAmount: 1.8, description: expect.stringMatching(/Toast Box · Meals · GST 9%$/) });
    expect(out.bill.total).toBe(23.14);
  });

  test('posts the bill, attaches the receipt, records the Xero id and an event', async () => {
    wf.markClaimed(report.id, emp);
    mockCreateInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-bill-1' }] } });
    const out = await bills.postReport(report.id, admin);
    expect(out.xeroInvoiceId).toBe('xero-bill-1');
    const sent = mockCreateInvoices.mock.calls[0][1].invoices[0];
    expect(sent).toMatchObject({ type: 'ACCPAY', status: 'DRAFT', contact: { contactID: 'contact-1' }, currencyCode: 'SGD' });
    expect(mockAttach).toHaveBeenCalledTimes(1);
    expect(mockAttach.mock.calls[0].slice(0, 3)).toEqual(['t1', 'xero-bill-1', 'R1.pdf']);
    const after = reports.getReport(report.id);
    // the status stays claimed: the Xero id is what records the posting
    expect(after).toMatchObject({ status: 'claimed', xeroInvoiceId: 'xero-bill-1', xeroError: null });
    expect(after.events.at(-1)).toMatchObject({ action: 'posted' });
    await expect(bills.postReport(report.id, admin)).rejects.toThrow(/already in Xero/);
  });

  test("Xero's validation error is stored on the report and surfaced", async () => {
    wf.markClaimed(report.id, emp);
    mockCreateInvoices.mockRejectedValue(new Error(JSON.stringify({ response: { statusCode: 400, body: { Elements: [{ ValidationErrors: [{ Message: 'Account code 494 is not valid' }] }] } } })));
    await expect(bills.postReport(report.id, admin)).rejects.toThrow(/Account code 494/);
    const after = reports.getReport(report.id);
    expect(after.status).toBe('claimed');
    expect(after.xeroError).toMatch(/Account code 494/);
    expect(after.events.at(-1).action).toBe('xero_failed');
  });

  test('re-checks what claiming checked: a line that lost its rate, or lines that no longer add up, does not post', async () => {
    wf.markClaimed(report.id, emp);
    const db = require('../db');
    const id = reports.getReport(report.id).expenses[0].id;
    db.prepare('UPDATE expense_lines SET base_cents = NULL WHERE expense_id = ?').run(id);
    await expect(bills.postReport(report.id, emp)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no exchange rate/) });
    db.prepare('UPDATE expense_lines SET base_cents = 134 WHERE expense_id = ?').run(id);
    db.prepare('UPDATE expenses SET total_cents = 25000 WHERE id = ?').run(id);
    await expect(bills.postReport(report.id, emp)).rejects.toThrow(/do not add up/);
    expect(mockCreateInvoices).not.toHaveBeenCalled();
  });

  test('advances above the claim are refused before anything is sent', async () => {
    users.saveCompanyConfig(admin.companyId, { ADVANCES_ACCOUNT_CODE: '610' });
    reports.updateReport(report.id, { advances: 5 });
    wf.markClaimed(report.id, emp);
    await expect(bills.postReport(report.id, emp)).rejects.toThrow(/advances are more than the claim/);
    expect(mockCreateInvoices).not.toHaveBeenCalled();
    expect(reports.getReport(report.id).xeroError).toBeNull();     // the claim was released
  });

  test('a case with an advance does not post until the advances account is set', async () => {
    reports.updateReport(report.id, { advances: 1 });
    wf.markClaimed(report.id, emp);
    await expect(bills.postReport(report.id, emp)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/advances account/) });
    expect(mockCreateInvoices).not.toHaveBeenCalled();
    const dry = await bills.postReport(report.id, emp, { dryRun: true });
    expect(dry.needsAdvancesAccount).toBe(true);
    users.saveCompanyConfig(admin.companyId, { ADVANCES_ACCOUNT_CODE: '610' });
    mockCreateInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-bill-adv' }] } });
    await bills.postReport(report.id, emp);
    expect(mockCreateInvoices.mock.calls[0][1].invoices[0].lineItems.at(-1)).toMatchObject({ unitAmount: -1, accountCode: '610' });
  });

  // The bill used to be built before the case was claimed for posting. While
  // the chart of accounts loaded, the case was reopened and changed, or an
  // admin corrected an amount, and Xero got one figure while the case, now
  // final, said another.
  test('while a case is being posted it cannot be reopened and its receipts cannot be corrected', async () => {
    wf.markClaimed(report.id, emp);
    const edit = require('../receipts/edit');
    const id = reports.getReport(report.id).expenses[0].id;
    let during = {};
    mockCreateInvoices.mockImplementation(async () => {
      try { wf.reopen(report.id, emp); during.reopen = 'allowed'; } catch (err) { during.reopen = err.status; }
      try { await edit.editDetails(id, { merchant: 'Changed' }, admin); during.edit = 'allowed'; } catch (err) { during.edit = err.status; }
      return { body: { invoices: [{ invoiceID: 'xero-bill-3' }] } };
    });
    await bills.postReport(report.id, emp);
    expect(during).toEqual({ reopen: 409, edit: 409 });
    expect(store.getExpense(id).merchant).toBe('Courtyard');
  });

  test('a case reopened before the post begins is not posted', async () => {
    wf.markClaimed(report.id, emp);
    wf.reopen(report.id, emp);
    expect(reports.claimForPost(report.id)).toBe(false);
    await expect(bills.postReport(report.id, emp)).rejects.toMatchObject({ status: 409 });
    expect(mockCreateInvoices).not.toHaveBeenCalled();
  });

  test('a second bill never replaces the one the case already records', async () => {
    wf.markClaimed(report.id, emp);
    expect(reports.recordBill(report.id, 'bill-A', null)).toBe(true);
    expect(reports.recordBill(report.id, 'bill-B', null)).toBe(false);
    expect(reports.getReport(report.id).xeroInvoiceId).toBe('bill-A');
  });

  // Xero's daily limit answers "retry after" twelve hours. Waiting that long
  // outlived the posting marker, a second click made a bill, and the first
  // attempt then woke and made another.
  test("a long 'retry after' from Xero fails at once and releases the case", async () => {
    wf.markClaimed(report.id, emp);
    mockCreateInvoices.mockRejectedValue({ response: { statusCode: 429, headers: { 'retry-after': '43200' } } });
    const t0 = Date.now();
    await expect(bills.postReport(report.id, emp)).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/about 12 hours/) });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(mockCreateInvoices).toHaveBeenCalledTimes(1);
    expect(reports.claimForPost(report.id)).toBe(true);      // released, so a later attempt can take it
  });

  test('the bill is recorded the moment Xero makes it, before the receipts go up, and is sent with an idempotency key', async () => {
    wf.markClaimed(report.id, emp);
    mockCreateInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-bill-2' }] } });
    let seenDuringUpload = null;
    mockAttach.mockImplementationOnce(async () => { seenDuringUpload = reports.getReport(report.id).xeroInvoiceId; });
    await bills.postReport(report.id, emp);
    expect(seenDuringUpload).toBe('xero-bill-2');
    expect(mockCreateInvoices.mock.calls[0][4]).toMatch(new RegExp(`^solv-${report.id}-[0-9a-f]{24}$`));
    expect(mockAttach.mock.calls[0][5]).toBe('xero-bill-2-R1.pdf');
    expect(reports.getReport(report.id).xeroError).toBeNull();
  });

  // Xero takes at most ten attachments on a bill.
  describe('more receipt files than Xero takes', () => {
    let att;
    beforeEach(() => {
      att = require('./attachments');
      att.forReceipt.mockImplementation(async (rc, { ref }) => [{ name: `${ref}.jpg`, mime: 'image/jpeg', buffer: Buffer.from(`jpg ${ref}`) }]);
      mockCreateInvoices.mockResolvedValue({ body: { invoices: [{ invoiceID: 'xero-bill-9' }] } });
    });
    // `n` more receipts in the case, one line each in the base currency.
    function more(n) {
      for (let i = 0; i < n; i++) {
        const rc = store.createReceipt({ companyId: admin.companyId, userId: emp.id, file: `x${i}.jpg`, mime: 'image/jpeg', sha256: `h${i}` });
        const e = store.createExpense({ companyId: admin.companyId, userId: emp.id, receiptId: rc.id, status: 'reviewed', merchant: `Cafe ${i + 2}`, currency: 'SGD', total: 10, receiptDate: '2026-09-05',
          lines: [{ category: 'Meals', amount: 10, baseAmount: 10, fxRate: 1, fxRateDate: '2026-09-05', fxSource: 'frankfurter', fxFetchedAt: 'x' }] });
        reports.addExpense(report.id, e.id);
      }
    }
    const sentNames = () => mockAttach.mock.calls.map(c => c[2]);
    const read = async stream => { const parts = []; for await (const c of stream) parts.push(Buffer.from(c)); return Buffer.concat(parts); };

    test('ten go as they are, one for each receipt, and no case PDF is made', async () => {
      more(9);
      wf.markClaimed(report.id, emp);
      await bills.postReport(report.id, emp);
      expect(sentNames()).toEqual(Array.from({ length: 10 }, (_, i) => `R${i + 1}.jpg`));
      expect(att.casePdfs).not.toHaveBeenCalled();
      expect(reports.getReport(report.id).xeroError).toBeNull();
    });

    test('fourteen receipts go as the case PDF, the cover and every receipt, named for them', async () => {
      more(13);
      wf.markClaimed(report.id, emp);
      const number = reports.getReport(report.id).number;
      await bills.postReport(report.id, emp);
      expect(sentNames()).toEqual([`${number} receipts 1-14.pdf`]);
      const pdf = await read(mockAttach.mock.calls[0][3]);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(Number(/\/Type \/Pages\s+\/Count (\d+)/.exec(pdf.toString('latin1'))[1])).toBeGreaterThanOrEqual(15);   // the cover, then a page a receipt
      expect(mockAttach.mock.calls[0][5]).toBe(`xero-bill-9-${number} receipts 1-14.pdf`);
      // Counting stopped at the eleventh file: the rest were never prepared.
      expect(att.forReceipt).toHaveBeenCalledTimes(11);
      expect(reports.getReport(report.id).xeroError).toBeNull();
    });

    test('a PDF already sent a page at a time counts as its pages', async () => {
      more(2);
      att.forReceipt.mockImplementation(async (rc, { ref }) => (ref === 'R2'
        ? Array.from({ length: 9 }, (_, i) => ({ name: `R2-p${i + 1}.jpg`, mime: 'image/jpeg', buffer: Buffer.from('p') }))
        : [{ name: `${ref}.jpg`, mime: 'image/jpeg', buffer: Buffer.from('j') }]));
      wf.markClaimed(report.id, emp);
      const number = reports.getReport(report.id).number;
      await bills.postReport(report.id, emp);
      expect(sentNames()).toEqual([`${number} receipts 1-3.pdf`]);
    });

    test('what does not fit in ten files is attached as far as it goes, and the rest is noted on the case', async () => {
      more(10);
      const parts = Array.from({ length: 10 }, (_, i) => ({ name: `EXP receipts ${3 * i + 1}-${3 * i + 3}.pdf`, mime: 'application/pdf', buffer: Buffer.from('%PDF'), refs: [`R${3 * i + 1}`, `R${3 * i + 2}`, `R${3 * i + 3}`] }));
      att.casePdfs.mockResolvedValueOnce({ files: parts, left: ['R31', 'R32'] });
      wf.markClaimed(report.id, emp);
      const out = await bills.postReport(report.id, emp);
      expect(sentNames()).toEqual(parts.map(p => p.name));
      expect(out.warnings).toEqual(['R31, R32: more than fits in the 10 files of 3 MB Xero takes on a bill. They are in the case\'s PDF export.']);
      const after = reports.getReport(report.id);
      expect(after.xeroInvoiceId).toBe('xero-bill-9');
      expect(after.xeroError).toMatch(/^Attachments: R31, R32: more than fits/);
    });

    test('a part Xero refuses is noted by the receipts in it, and the others still go', async () => {
      more(11);
      att.casePdfs.mockResolvedValueOnce({ files: [
        { name: 'A.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF'), refs: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'] },
        { name: 'B.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF'), refs: ['R7', 'R8', 'R9', 'R10', 'R11', 'R12'] },
      ], left: [] });
      mockAttach.mockRejectedValueOnce(new Error('The file is too large'));
      wf.markClaimed(report.id, emp);
      const out = await bills.postReport(report.id, emp);
      expect(sentNames()).toEqual(['A.pdf', 'B.pdf']);
      expect(out.warnings).toEqual([expect.stringMatching(/^R1-R6: .*too large/)]);
    });

    test('a receipt that cannot be prepared is noted, and the others still go', async () => {
      more(2);
      att.forReceipt.mockImplementation(async (rc, { ref }) => {
        if (ref === 'R2') throw new Error('The file is unreadable');
        return [{ name: `${ref}.jpg`, mime: 'image/jpeg', buffer: Buffer.from('j') }];
      });
      wf.markClaimed(report.id, emp);
      const out = await bills.postReport(report.id, emp);
      expect(sentNames()).toEqual(['R1.jpg', 'R3.jpg']);
      expect(out.warnings).toEqual(['R2: The file is unreadable']);
      expect(reports.getReport(report.id).xeroInvoiceId).toBe('xero-bill-9');
    });
  });

  test('a posting marker left by a process that died is taken over after ten minutes', () => {
    wf.markClaimed(report.id, emp);
    expect(reports.claimForPost(report.id)).toBe(true);
    expect(reports.claimForPost(report.id)).toBe(false);
    require('../db').prepare("UPDATE expense_reports SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(report.id);
    expect(reports.claimForPost(report.id)).toBe(true);
  });
});

describe('xero/bills — dates', () => {
  test('the bill is dated the day it was claimed where the company is', () => {
    const bills = require('./bills');
    const out = bills.buildBill({ company: { baseCurrency: 'SGD', timezone: 'Asia/Singapore' }, report: { number: 'C-1', claimedAt: '2026-09-30T23:30:00.000Z' }, lines: [] });
    expect(out.invoice.date).toBe('2026-10-01');      // 07:30 on 1 Oct in Singapore
  });
});
