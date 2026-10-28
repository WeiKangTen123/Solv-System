const { taxLine, paymentLine, totalLine, serviceLine, tipLine, adjustmentLine } = require('./line-kinds');

describe('receipts/line-kinds', () => {
  test.each([
    'GST 9%', 'CGST 9%- Rooms-(New)', 'JW Cafe CGST 9% -[Add: 9%-(B)]', 'SGST Momo Cafe F&B 9%', 'MwSt / VAT gesamt', 'VAT 7% on Service Fee',
    'SST 6%', 'Service Tax 6%', 'PPN 11%', 'PB1 10%', '消費税(10%)', 'HST 13%', 'IVA 16%', 'TVA 20%', 'Sales Tax 8.625%', 'Tax', 'Total GST', '9% GST', 'Add GST',
  ])('"%s" is a tax line', d => expect(taxLine(d)).toEqual({ included: false }));

  test.each(['GST 9% (incl.)', 'enth. MwSt 7% (Logis 360,00)', 'GST 9% INCLUDED', '(内消費税等 ¥278)', 'inkl. MwSt 19%'])('"%s" is a tax already in the prices', d => {
    expect(taxLine(d)).toEqual({ included: true });
  });

  test.each(['Room charge (incl. GST)', 'Tax free shopping', 'Tax-free', 'City Tax 5%', 'Tourism Tax', 'Kurtaxe', 'Room Tax', 'Service Charge 10%', 'SVC CHG', 'SF Mandate 4%', 'Taxi fare', 'Total incl. GST', 'Upsell Breakfast', '', null])('"%s" is not', d => {
    expect(taxLine(d)).toBeNull();
  });

  test('payments: the card, the cash and the change, but not a visa fee', () => {
    for (const d of ['VISA ****1234', 'Visa', 'Paid by VISA ****7731', 'Manual MasterCard / Euro Card', 'Cash', 'CHANGE', 'Card', 'Tunai', 'Kembali', 'お預り', 'Refunded to VISA ****5512']) expect(paymentLine(d)).toBe(true);
    for (const d of ['Tourist Visa Fee (Single Entry)', 'Visa application', 'Cash rebate', 'Chicken rice']) expect(paymentLine(d)).toBe(false);
  });

  test('a total or subtotal printed as a line, but not a tax total', () => {
    for (const d of ['Total', 'TOTAL S$', 'Sub Total', 'Grand Total', 'Total incl. GST', 'Amount due', '合計']) expect(totalLine(d)).toBe(true);
    for (const d of ['Total GST', 'Totally Tea', 'Package']) expect(totalLine(d)).toBe(false);
  });

  test('service charges, tips and the other charges after a subtotal', () => {
    expect([serviceLine('Service 5%'), serviceLine('Service Charge 10%'), serviceLine('Service Tax 6%'), serviceLine('VFS Service Fee')]).toEqual([true, true, false, false]);
    expect([tipLine('Tip'), tipLine('Gratuity 18%'), tipLine('Tipping point café')]).toEqual([true, true, false]);
    expect([adjustmentLine('SF Mandate 4%'), adjustmentLine('Rounding Adj'), adjustmentLine('Tourism Tax'), adjustmentLine('SST 6%')]).toEqual([true, true, true, false]);
  });
});
