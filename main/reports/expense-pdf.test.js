const pdf = require('./expense-pdf');
const { DECLARED_NOTE } = require('./declaration');

// A claimed trip: a hotel folio of two lines (R1), a manually priced dinner
// (R2), a taxi in the base currency (R3), a per diem and a line with no
// receipt at all.
const base = () => ({
  company: { name: 'Solv Pte Ltd', baseCurrency: 'SGD', timezone: 'Asia/Singapore', fxPolicy: 'receipt_date', reportColumns: ['Air & Transport', 'Lodging', 'Meals', 'Other'] },
  report: { number: 'EXP-2026-0007', kind: 'trip', title: 'India trip', purpose: 'Client site visits, India', periodFrom: '2026-08-31', periodTo: '2026-09-04', destination: 'Mumbai and Pune, India', nights: 4,
            status: 'claimed', claimedAt: '2026-09-10T06:02:00Z', advances: 0, notes: null,
            events: [{ action: 'created', at: '2026-09-01T02:00:00Z', actorName: 'Aisha Mei Ling Rahman', note: null }, { action: 'claimed', at: '2026-09-10T06:02:00Z', actorName: 'Aisha Mei Ling Rahman', note: DECLARED_NOTE }] },
  owner: { name: 'Aisha Mei Ling Rahman', employeeId: 'S0001', department: 'Sales', email: 'aisha@solv.sg' },
  lines: [
    { ref: 'R1', expenseId: 'e1', date: '2026-09-01', merchant: 'JW Marriott Mumbai Sahar', purpose: 'Client visit', description: 'Rooms', category: 'Lodging', currency: 'INR', amount: 20738.5, fxRate: 0.01341, fxRateDate: '2026-09-01', fxSource: 'frankfurter', baseAmount: 278.1, tax: 3379.5, baseTax: 45.32 },
    { ref: 'R1', expenseId: 'e1', date: '2026-09-01', merchant: 'JW Marriott Mumbai Sahar', purpose: 'Client visit', description: 'Room for a colleague', category: 'Lodging', currency: 'INR', amount: 20737.5, fxRate: 0.01341, fxRateDate: '2026-09-02', fxSource: 'frankfurter', baseAmount: 278.09, onBehalfOf: 'Lim Wei Jie' },
    { ref: 'R2', expenseId: 'e2', date: '2026-09-04', merchant: 'Courtyard Pune', description: 'Dinner', category: 'Meals', currency: 'INR', amount: 6426.57, fxRate: 0.0135, fxRateDate: '2026-09-04', fxSource: 'manual', fxOverrideBy: 'aisha@solv.sg', fxOverrideReason: 'card statement', baseAmount: 86.76 },
    { ref: 'R3', expenseId: 'e3', date: '2026-09-02', merchant: 'Grab', description: 'Airport', category: 'Air & Transport', currency: 'SGD', amount: 18.4, fxRate: 1, fxSource: 'base', baseAmount: 18.4, tax: 1.52 },
    { ref: null, expenseId: 'e4', source: 'per_diem', date: '2026-08-31', merchant: 'Per diem', description: 'India: 5 days × INR 4,000', category: 'Meals', currency: 'INR', amount: 20000, fxRate: 0.01341, fxRateDate: '2026-08-31', fxSource: 'frankfurter', baseAmount: 268.2 },
    { ref: null, expenseId: 'e5', date: '2026-09-03', merchant: 'Auto rickshaw', category: 'Phone', currency: 'SGD', amount: 4, fxRate: 1, fxSource: 'base', baseAmount: 4 },
  ],
  receipts: [{ ref: 'R1', title: 'JW Marriott Mumbai Sahar', date: '2026-09-01', pages: [] }, { ref: 'R2', title: 'Courtyard Pune', pages: [] }, { ref: 'R3', title: 'Grab', pages: [] }],
  flags: { e2: [{ level: 'yellow', code: 'over-limit', text: 'SGD 86.76 is over the Meals limit of SGD 40.00 a receipt.' }, { level: 'yellow', code: 'weekend', text: 'It is dated on a Friday.' }] },
  generatedAt: Date.parse('2026-09-18T04:00:00Z'),
});
const text = d => JSON.stringify(d.content);
const tocTitles = d => d.content.find(c => c.table && c.table.widths && c.table.widths[1] === 40).table.body.map(r => r[0].text);

describe('reports/expense-pdf — the document', () => {
  test('A4 portrait; the cover has no header, and its footer says when it was made; every other page has both', () => {
    const d = pdf.expenseReportDoc(base());
    expect(d).toMatchObject({ pageSize: 'A4', pageOrientation: 'portrait' });
    expect(d.header(1)).toBeNull();
    expect(JSON.stringify(d.header(2))).toContain('EXP-2026-0007');
    expect(d.footer(1, 9).text).toMatch(/^Generated from Solv on 18 Sep 2026 12:00 SGT/);
    expect(JSON.stringify(d.footer(3, 9))).toContain('Page 3 of 9');
    expect(d.background(1)).not.toBeNull();
    expect(d.background(2)).toBeNull();
  });

  test('the cover names the case, the claimant, the dates and the amount, and lists what is inside with page numbers', () => {
    const d = pdf.expenseReportDoc(base());
    const t = text(d);
    for (const s of ['EXPENSE CLAIM', 'India trip', 'Client site visits, India', 'EXP-2026-0007', 'S0001 · Sales', '31 Aug – 4 Sep 2026 · 4 nights', 'Mumbai and Pune, India', 'AMOUNT TO REIMBURSE', 'SGD 933.55', '6 lines', '3 receipts', '2 currencies', '2 items to note']) {
      expect(t).toContain(s);
    }
    expect(tocTitles(d)).toEqual(['Summary', 'Expense details', 'Allowances', 'Items to note', 'Activity', 'Receipts R1 – R3']);
    expect(t).toContain('"pageReference":"sec-receipts"');
    // The claim is dated where the company is: 23:30 UTC on 30 Sep is 1 Oct in Singapore.
    const late = base(); late.report.claimedAt = '2026-09-30T23:30:00Z';
    expect(text(pdf.expenseReportDoc(late))).toContain('1 Oct 2026');
    expect(text(pdf.expenseReportDoc(late))).not.toContain('30 Sep 2026');
  });

  test('a section with nothing in it is left out, and so is its line in the contents', () => {
    const p = base();
    p.lines = p.lines.filter(l => !l.source && l.ref);
    p.flags = {}; p.report.events = []; p.receipts = [];
    const d = pdf.expenseReportDoc(p);
    expect(tocTitles(d)).toEqual(['Summary', 'Expense details']);
    expect(text(d)).not.toContain('sec-receipts');
  });

  test('an advance bigger than the spending is money owed back, said in words, not a minus sign', () => {
    const p = base(); p.report.advances = 1000;
    const t = text(pdf.expenseReportDoc(p));
    expect(t).toContain('OWED BACK TO THE COMPANY');
    expect(t).toContain('SGD 66.45');
    expect(t).toContain('Owed back to the company');
    expect(t).toContain('Less advance received');
    expect(t).not.toMatch(/SGD -/);
    // No advance: no "advances SGD 0.00" line.
    expect(text(pdf.expenseReportDoc(base()))).not.toContain('advance');
  });

  test('every line shows the receipt behind it, as a link to that receipt\'s page; an allowance has none, and a missing receipt says so', () => {
    const d = pdf.expenseReportDoc(base());
    const table = d.content.find(c => c.table && c.table.headerRows === 1 && c.table.body[0].length === 8).table;
    expect(table.body[0].map(c => c.text)).toEqual(['#', 'Date', 'Rcpt', 'Merchant', 'Category', 'Amount', 'Rate', 'SGD']);
    expect(table.body[1][2]).toMatchObject({ text: 'R1', linkToDestination: 'receipt-R1' });
    expect(table.body[5][2].text).toBe('—');
    expect(table.body[6][2].text).toBe('none');
    expect(table.body.at(-1).at(-1).text).toBe('933.55');
    // The flagged dinner carries the mark beside its number.
    expect(JSON.stringify(table.body[3][0])).toContain(' !');
    expect(JSON.stringify(table.body[1][0])).not.toContain('!');
    expect(text(d)).toContain('Paid for Lim Wei Jie');
  });

  test('items to note: one row per receipt with all its flags, and a line with no receipt; an allowance is not asked for one', () => {
    const m = pdf.pdfModel(base());
    expect(m.notes).toEqual([
      { level: 'yellow', lines: [3], ref: 'R2', merchant: 'Courtyard Pune', texts: [{ text: 'SGD 86.76 is over the Meals limit of SGD 40.00 a receipt.', red: false }, { text: 'It is dated on a Friday.', red: false }] },
      { level: 'yellow', lines: [6], ref: null, merchant: 'Auto rickshaw', texts: [{ text: 'No receipt is attached.', red: false }] },
    ]);
    const red = base(); red.flags.e3 = [{ level: 'red', code: 'no-date', text: 'No date.' }];
    expect(pdf.pdfModel(red).notes[0]).toMatchObject({ level: 'red', ref: 'R3' });
  });

  test('rates are said once per currency and source with their dates; a manual rate names its line, who and why', () => {
    const m = pdf.pdfModel(base());
    expect(m.rateNotes).toEqual([
      'INR to SGD 0.01341: European Central Bank reference rate for 31 Aug – 2 Sep 2026, via Frankfurter.',
      'Line 3: INR to SGD 0.0135, entered by aisha@solv.sg on 4 Sep 2026: card statement.',
      "Rates follow the company's policy: rate on the receipt date. Each line is converted and rounded to the cent; the total is the sum of the lines.",
    ]);
    expect(m.currencies.map(c => [c.code, c.amount, c.base])).toEqual([['SGD', 22.4, 22.4], ['INR', 67902.57, 911.15]]);
  });

  test('the summary groups by category as the company lists them, the rest under Other, with the tax printed on the receipts', () => {
    const m = pdf.pdfModel(base());
    expect(m.categories.map(c => [c.name, c.lines, c.amount])).toEqual([['Air & Transport', 1, 18.4], ['Lodging', 2, 556.19], ['Meals', 2, 354.96], ['Other', 1, 4]]);
    expect(m.tax).toEqual({ local: 1.52, foreign: 45.32, name: 'GST' });
    expect(text(pdf.expenseReportDoc(base()))).toContain('(not Singapore input tax)');
  });

  test('the declaration is said as made only when the claim window showed it; an open case says it is not claimed yet', () => {
    expect(text(pdf.expenseReportDoc(base()))).toContain('Declared in Solv by Aisha Mei Ling Rahman when marking the case claimed, 10 Sep 2026 14:02 SGT.');
    const before = base(); before.report.events[1].note = null;
    const t = text(pdf.expenseReportDoc(before));
    expect(t).toContain('before Solv asked for this declaration');
    expect(t).not.toContain('Declared in Solv');
    // Claimed, reopened and claimed again without it: the last claim decides.
    const again = base(); again.report.events.push({ action: 'reopened', at: '2026-09-11T01:00:00Z' }, { action: 'claimed', at: '2026-09-12T01:00:00Z', note: null });
    expect(text(pdf.expenseReportDoc(again))).not.toContain('Declared in Solv');
    const open = base(); open.report.status = 'open'; open.report.claimedAt = null;
    expect(text(pdf.expenseReportDoc(open))).toContain('Not claimed yet.');
    expect(text(pdf.expenseReportDoc(open))).toContain('not yet claimed');
    for (const d of [base(), open]) {
      const all = text(pdf.expenseReportDoc(d));
      expect(all).toContain('I declare that the expenses in this claim were incurred wholly and exclusively for the business of Solv Pte Ltd');
      expect(all).not.toContain('Approved by');
      expect(all).not.toContain('Manager');
    }
  });

  test('a posted case says so in the finance box, with the start of its bill id', () => {
    const p = base(); p.report.xeroInvoiceId = '1a2b3c4d-0000-4000-8000-000000000000';
    p.report.events.push({ action: 'posted', at: '2026-09-11T02:00:00Z', note: 'Xero bill 1a2b3c4d' });
    expect(text(pdf.expenseReportDoc(p))).toContain('In Xero since 11 Sep 2026 · bill 1a2b3c4d.');
    expect(text(pdf.expenseReportDoc(base()))).toContain('Not posted to Xero from Solv.');
  });

  test('each receipt starts a page saying which lines it backs, with a link back; page 2 of a receipt keeps its name', () => {
    const p = base();
    const page = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
    p.receipts[0].pages = [{ dataUri: page }, { dataUri: page }];
    const d = pdf.expenseReportDoc(p);
    const t = text(d);
    expect(t).toContain('For lines 1, 2 · Lodging');
    expect(t).toContain('INR 41,476.00 = SGD 556.19');
    expect(t).toContain('"linkToDestination":"line-1"');
    expect(t).toContain('page 2 of 2');
    expect(t).toContain('"id":"receipt-R1"');
    expect(d.content.filter(c => c.id === 'sec-receipts')).toHaveLength(1);
    expect(d.content.filter(c => c.image === page)).toHaveLength(2);
  });

  test('a logo is given once, by name; anything that is not a PNG or JPEG data URL is left out', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAACCAYAAABllJ3tAAAAEElEQVR4nGNgQAX/z6AJAAAeDgL2Y8QeRgAAAABJRU5ErkJggg==';
    const p = base(); p.company.logo = png;
    const d = pdf.expenseReportDoc(p);
    expect(d.images).toEqual({ logo: png });
    expect(text(d)).toContain('"image":"logo"');
    expect(JSON.stringify(d.header(2))).toContain('"image":"logo"');
    const bad = base(); bad.company.logo = 'javascript:alert(1)';
    expect(pdf.expenseReportDoc(bad).images).toEqual({});
    expect(text(pdf.expenseReportDoc(bad))).not.toContain('"image"');
  });

  test('text in Chinese goes to the Chinese font; what neither font draws prints as "?"', () => {
    const p = base(); p.lines[3].merchant = '海底捞 Haidilao'; p.owner.name = 'Somchai สมชาย';
    const t = text(pdf.expenseReportDoc(p));
    expect(t).toContain('{"text":"海底捞","font":"NotoSansSC"}');
    expect(t).toContain('Somchai ?????');
  });
});

describe('reports/expense-pdf — rendered', () => {
  test('it renders, the contents point at real pages, and the numbers in the contents are the pages', async () => {
    const { pdfBuffer } = require('./expense-export');
    const buf = await pdfBuffer(pdf.expenseReportDoc(base()));
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    // Cover, summary, details, the rest, and one page per receipt.
    expect(Number(/\/Type \/Pages\s+\/Count (\d+)/.exec(buf.toString('latin1'))[1])).toBe(7);
  }, 30000);
});

describe('reports/expense-pdf — formatting', () => {
  test('date spans and line numbers', () => {
    expect(pdf._fmtSpan('2026-10-04', '2026-10-08')).toBe('4 – 8 Oct 2026');
    expect(pdf._fmtSpan('2026-09-28', '2026-10-03')).toBe('28 Sep – 3 Oct 2026');
    expect(pdf._fmtSpan('2026-12-30', '2027-01-02')).toBe('30 Dec 2026 – 2 Jan 2027');
    expect(pdf._fmtSpan('2026-10-04', null)).toBe('4 Oct 2026');
    expect(pdf._fmtSpan(null, null)).toBeNull();
    expect(pdf._fmtNumbers([9, 10, 11, 3])).toBe('3, 9–11');
    expect(pdf._fmtNumbers([4, 5])).toBe('4, 5');
  });
});
