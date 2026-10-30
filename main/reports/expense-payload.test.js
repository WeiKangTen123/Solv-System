jest.mock('../store/reports', () => ({ getReport: jest.fn() }));
jest.mock('../store/users', () => ({ getCompany: jest.fn(() => ({ id: 'c1', name: 'Solv Pte Ltd', baseCurrency: 'SGD', timezone: 'Asia/Singapore' })), findById: jest.fn(() => ({ name: 'Aisha' })) }));
jest.mock('../receipts/flags', () => ({ flagsFor: jest.fn(() => []) }));

const reports = require('../store/reports');
const { reportPayload } = require('./expense-payload');

// A KL hotel kept as printed: the room carries its Service Tax 8% and the
// tourism tax, the restaurant its SST 6%; a Singapore receipt that only says
// "Price payable includes GST"; a taxi that prints no tax; and a receipt from
// before receipts were kept as printed, with one tax figure for two lines.
const expense = (id, currency, lines, extra = {}) => ({ id, merchant: id, receiptDate: '2026-10-12', currency, receipt: { id: `r-${id}` }, lines, ...extra });
const caseOf = expenses => ({ id: 'rep1', companyId: 'c1', userId: 'u1', expenses });

describe('reports/expense-payload — tax as printed', () => {
  test("each line's taxes are its own, converted at the line's rate; tax and baseTax are their sums", async () => {
    reports.getReport.mockReturnValue(caseOf([
      expense('Hotel', 'MYR', [
        { category: 'Lodging', amount: 342.64, currency: 'MYR', fxRate: 0.3049, baseAmount: 104.47, taxes: [{ label: 'Service Tax', rate: 8, amount: 24.64, included: false, gross: 332.64 }] },
        { category: 'Meals', amount: 99.11, currency: 'MYR', fxRate: 0.3049, baseAmount: 30.22, taxes: [{ label: 'SST', rate: 6, amount: 5.61, included: false, gross: 99.11 }] },
      ], { tax: 30.25 }),
      // The record says the GST was worked out; the line's taxes do not.
      expense('Toast Box', 'SGD', [{ category: 'Meals', amount: 21.8, currency: 'SGD', fxRate: 1, fxSource: 'base', baseAmount: 21.8,
        taxes: [{ label: 'GST', rate: 9, amount: 1.8, included: true, gross: 21.8 }] }],
      { tax: 1.8, printed: { v: 1, subtotal: null, total: 21.8, rows: [{ kind: 'item', label: 'Kaya toast set', amount: 21.8 }, { kind: 'tax', label: 'GST', rate: 9, amount: 1.8, included: true, worked: true }] } }),
      expense('Grab KL', 'MYR', [{ category: 'Air & Transport', amount: 25, currency: 'MYR', fxRate: 0.3049, baseAmount: 7.62, taxes: [] }], { tax: null }),
    ]));
    const p = await reportPayload('rep1', { withReceipts: false });
    const [room, food, toast, taxi] = p.lines;
    expect(room).toMatchObject({ tax: 24.64, baseTax: 7.51, taxText: 'incl. Service Tax 8% · MYR 24.64' });
    expect(room.taxes).toEqual([{ label: 'Service Tax', rate: 8, amount: 24.64, included: false, gross: 332.64, baseAmount: 7.51, baseGross: 101.42 }]);
    // The two rates stay two: not 30.25 shared out over the two lines by amount.
    expect(food).toMatchObject({ tax: 5.61, baseTax: 1.71, taxText: 'incl. SST 6% · MYR 5.61' });
    expect(toast).toMatchObject({ tax: 1.8, baseTax: 1.8, taxText: 'incl. GST 9% · SGD 1.80, worked out' });
    expect(taxi).toMatchObject({ taxes: [], tax: 0, baseTax: 0, taxText: null });
  });

  test('a CGST and SGST pair is two taxes on one line, said one after the other', async () => {
    reports.getReport.mockReturnValue(caseOf([expense('JW Marriott', 'INR', [
      { category: 'Lodging', amount: 22420, currency: 'INR', fxRate: 0.01541, baseAmount: 345.49,
        taxes: [{ label: 'CGST', rate: 9, amount: 1710, included: false, gross: 22420 }, { label: 'SGST', rate: 9, amount: 1710, included: false, gross: 22420 }] },
      // A foreign line still waiting for its rate has no base figure yet.
      { category: 'Lodging', amount: 11210, currency: 'INR', fxRate: null, baseAmount: null, onBehalfOf: 'Lim Wei Jie',
        taxes: [{ label: 'CGST', rate: 9, amount: 855, included: false, gross: 11210 }, { label: 'SGST', rate: 9, amount: 855, included: false, gross: 11210 }] },
    ])]));
    const p = await reportPayload('rep1', { withReceipts: false });
    expect(p.lines[0]).toMatchObject({ tax: 3420, baseTax: 52.7, taxText: 'incl. CGST 9% · INR 1,710.00; incl. SGST 9% · INR 1,710.00' });
    expect(p.lines[1]).toMatchObject({ tax: 1710, baseTax: null });
    expect(p.lines[1].taxes.map(t => t.baseAmount)).toEqual([null, null]);
  });

  test('a receipt from before keeps its one tax figure, shared over its lines by amount', async () => {
    reports.getReport.mockReturnValue(caseOf([expense('Grab', 'SGD', [
      { category: 'Air & Transport', amount: 12.4, currency: 'SGD', fxRate: 1, baseAmount: 12.4, taxes: null },
      { category: 'Meals', amount: 6, currency: 'SGD', fxRate: 1, baseAmount: 6, taxes: null },
    ], { tax: 1.52 })]));
    const p = await reportPayload('rep1', { withReceipts: false });
    expect(p.lines.map(l => [l.taxes, l.tax, l.baseTax, l.taxText])).toEqual([[null, 1.02, 1.02, 'incl. tax · SGD 1.02'], [null, 0.5, 0.5, 'incl. tax · SGD 0.50']]);
  });
});
