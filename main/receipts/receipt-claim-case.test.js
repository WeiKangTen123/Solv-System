// A fixed rate: the test is about filing, and it used to ask the real rate
// provider over the network, which made it fail whenever that was slow.
jest.mock('../fx/rates', () => ({ getRate: jest.fn().mockResolvedValue({ rate: 0.0161, rateDate: '2026-08-31', providerDate: '2026-08-31', source: 'frankfurter', fetchedAt: '2026-09-01T00:00:00.000Z' }) }));
const fs = require('fs');
const path = require('path');
const { newId } = require('../utils/ids');

// Test Case: Filing the 2 receipts from samples/receipts/ into an Expense Claim Case
describe('receipts/receipt-claim-case — filing 2 receipts into a claim case', () => {
  let store, reports, users, readReceipt;
  let user, company, claimCase;

  const jwMumbaiRead = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../samples/reads/jw-marriott-mumbai.json'), 'utf8')
  );
  const courtyardPuneRead = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../samples/reads/courtyard-marriott-pune.json'), 'utf8')
  );

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users');
    store = require('../store/expenses');
    reports = require('../store/reports');
    readReceipt = require('./read-receipt');

    company = users.createCompany({ name: 'Solv Travel Corp', baseCurrency: 'SGD' });
    user = await users.createUser({ companyId: company.id, email: `aisha-${Date.now()}@solv.local`, password: 'password123', name: 'Aisha Rahman' });

    // Create a new expense claim case
    claimCase = reports.createReport({
      companyId: company.id,
      userId: user.id,
      kind: 'case',
      title: 'India Trip - Hotel Folios Claim',
      purpose: 'Client visits in Mumbai & Pune'
    });
  });

  test('receipt 1 (JW Marriott Mumbai) builds 4 reconciled lines and identifies colleague transfer', () => {
    const lines = readReceipt.buildLines(jwMumbaiRead, 'Other');
    expect(lines).toHaveLength(4);

    const totalLinesAmount = lines.reduce((s, l) => s + l.amount, 0);
    expect(totalLinesAmount).toBeCloseTo(44309, 2);

    const colleagueLines = lines.filter(l => l.onBehalfOf === 'Lim Wei Jie');
    expect(colleagueLines).toHaveLength(2); // Lodging and Meals for Lim Wei Jie

    const ownLines = lines.filter(l => !l.onBehalfOf);
    expect(ownLines).toHaveLength(2); // Lodging and Meals for Claimant
  });

  test('receipt 2 (Courtyard Marriott Pune) builds reconciled lines across 4 folio pages', () => {
    const lines = readReceipt.buildLines(courtyardPuneRead, 'Other');
    const totalLinesAmount = lines.reduce((s, l) => s + l.amount, 0);
    expect(totalLinesAmount).toBeCloseTo(88188.77, 2);

    const colleagueLines = lines.filter(l => l.onBehalfOf === 'Lim Wei Jie');
    expect(colleagueLines.length).toBeGreaterThanOrEqual(1);
  });

  test('files both receipts into a claim case and transitions from unreviewed to ready for claim', async () => {
    // 1. Add JW Marriott Mumbai to case
    const r1 = store.createReceipt({
      id: newId(),
      companyId: company.id,
      userId: user.id,
      file: 'jw-marriott-mumbai.pdf',
      mime: 'application/pdf',
      sizeBytes: 467671,
      sha256: 'hash1'
    });
    const e1 = store.createExpense({
      companyId: company.id,
      userId: user.id,
      receiptId: r1.id,
      currency: 'INR',
      status: 'reading'
    });
    reports.addExpense(claimCase.id, e1.id);
    await readReceipt.applyRead(e1.id, jwMumbaiRead);

    // 2. Add Courtyard Marriott Pune to case
    const r2 = store.createReceipt({
      id: newId(),
      companyId: company.id,
      userId: user.id,
      file: 'courtyard-marriott-pune.pdf',
      mime: 'application/pdf',
      sizeBytes: 1238538,
      sha256: 'hash2'
    });
    const e2 = store.createExpense({
      companyId: company.id,
      userId: user.id,
      receiptId: r2.id,
      currency: 'INR',
      status: 'reading'
    });
    reports.addExpense(claimCase.id, e2.id);
    await readReceipt.applyRead(e2.id, courtyardPuneRead);

    // Initial check: case contains 2 receipts, both unreviewed
    let reportState = reports.getReport(claimCase.id);
    expect(reportState.expenses).toHaveLength(2);
    expect(reportState.totals.unreviewed).toBe(2);

    // Claimant reviews both expenses
    store.updateExpense(e1.id, { status: 'reviewed', purpose: 'Accommodation in Mumbai' });
    store.updateExpense(e2.id, { status: 'reviewed', purpose: 'Accommodation in Pune' });

    // Review complete check: unreviewed drops to 0, case is claimable
    reportState = reports.getReport(claimCase.id);
    expect(reportState.totals.unreviewed).toBe(0);
    expect(reportState.totals.expenseCount).toBe(2);
    expect(reportState.totals.lineCount).toBeGreaterThan(0);
    expect(reportState.totals.byCategory.Lodging).toBeGreaterThan(0);
  });
});
