const doc = require('./expense-doc');

const payload = {
  company: { name: 'Solv Pte Ltd', baseCurrency: 'SGD', timezone: 'Asia/Singapore', fxPolicy: 'receipt_date', reportColumns: ['Air & Transport', 'Lodging', 'Meals', 'Entertainment', 'Phone', 'Fuel/Mileage', 'Other'] },
  report: { number: 'EXP-2026-0007', kind: 'trip', title: 'India trip', purpose: 'Client site visits, India', periodFrom: '2026-08-31', periodTo: '2026-09-04', destination: 'Mumbai and Pune, India', nights: 4,
            status: 'approved', submittedAt: '2026-09-05T02:00:00Z', approvedAt: '2026-09-10T06:02:00Z', advances: 0, notes: null },
  owner: { name: 'Elaine Xin Yu Khoo', employeeId: 'S0042', department: 'Sales', email: 'elaine@solv.sg' },
  manager: { name: 'Henry Bennett' }, approver: { name: 'Henry Bennett' },
  lines: [
    { ref: 'R1', date: '2026-09-01', merchant: 'JW Marriott Mumbai Sahar', purpose: 'Client visit', description: 'Rooms', category: 'Lodging', currency: 'INR', amount: 20738.5, fxRate: 0.01341, fxRateDate: '2026-09-01', fxSource: 'frankfurter', fxFetchedAt: '2026-09-18T03:58:00Z', baseAmount: 278.1, onBehalfOf: null, tax: 3379.5 },
    { ref: 'R1', date: '2026-09-01', merchant: 'JW Marriott Mumbai Sahar', purpose: 'Client visit', description: 'Rooms', category: 'Lodging', currency: 'INR', amount: 20737.5, fxRate: 0.01341, fxRateDate: '2026-09-01', fxSource: 'frankfurter', fxFetchedAt: '2026-09-18T03:58:00Z', baseAmount: 278.09, onBehalfOf: 'Tan Suan Kuan', tax: null },
    { ref: 'R2', date: '2026-09-04', merchant: 'Courtyard By Marriott Pune Chakan', purpose: null, description: 'MoMo Cafe', category: 'Meals', currency: 'INR', amount: 6426.57, fxRate: 0.0135, fxRateDate: '2026-09-04', fxSource: 'manual', fxOverrideBy: 'elaine@solv.sg', fxOverrideReason: 'card statement', fxFetchedAt: 'x', baseAmount: 86.76, onBehalfOf: null, tax: null },
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
    expect(m.rateNotes[1]).toMatch(/INR→SGD 0\.0135 entered by elaine@solv\.sg on 4 Sep 2026: card statement/);
    expect(m.notes.join(' ')).toMatch(/rounded to the cent/);
    expect(m.notes.join(' ')).toMatch(/Tan Suan Kuan/);
    expect(m.notes.join(' ')).toMatch(/foreign tax/i);
  });

  test('the PDF definition carries the cover, the table with a total row, the signature block and one appendix section per receipt', () => {
    const d = doc.expenseReportDoc(payload);
    expect(d.pageOrientation).toBe('landscape');
    const text = JSON.stringify(d);
    expect(text).toContain('EXP-2026-0007');
    expect(text).toContain('Elaine Xin Yu Khoo');
    expect(text).toContain('Mumbai and Pune, India');
    expect(text).toContain('SGD 661.35');
    expect(text).toContain('Approved by');
    expect(text).toContain('R2');
    expect(text).toContain('rounded to the cent');
    const table = d.content.find(c => c.table && c.table.headerRows === 1).table;
    expect(table.body[0].map(c => c.text)).toEqual(['#', 'Date', 'Description', 'Ccy', 'Amount', 'Rate', 'Lodging', 'Meals', 'Other', 'Total SGD']);
    expect(table.body.at(-1).map(c => c.text)).toContain('661.35');
    expect(d.content.filter(c => c.pageBreak === 'before')).toHaveLength(3);
  });

  test('the CSV has one row per line with the base amount, and the workbook model has four sheets', () => {
    const csv = doc.expenseReportCsv(payload);
    expect(csv.split('\n')[0]).toBe('Report,Line,Date,Merchant,Description,Purpose,On behalf of,Category,Currency,Amount,Rate,Rate date,Rate source,SGD,Receipt');
    expect(csv.split('\n')).toHaveLength(5);
    expect(csv).toContain('EXP-2026-0007,1,2026-09-01,JW Marriott Mumbai Sahar,Rooms,Client visit,,Lodging,INR,20738.50,0.01341,2026-09-01,frankfurter,278.10,R1');
    expect(doc.workbookModel(payload).sheets.map(s => s.name)).toEqual(['Cover', 'Lines', 'Rates', 'Receipts']);
    expect(doc.exportFilename(payload)).toBe('EXP-2026-0007_Elaine-Xin-Yu-Khoo');
  });

  test('text outside Latin-1 is folded, but the dash, quote, dagger and arrow survive', () => {
    expect(doc._latin1('Café – ‘ok’ ‡ → 東京 — end')).toBe('Café – ‘ok’ ‡ to ?? — end');
  });
});
