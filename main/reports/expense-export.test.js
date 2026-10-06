// The XLSX export, end to end through ExcelJS.
describe('reports/expense-export', () => {
  let users, store, reports, payload, exp, u;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../store/users'); store = require('../store/expenses'); reports = require('../store/reports');
    payload = require('./expense-payload').reportPayload; exp = require('./expense-export');
    u = await users.createUser({ email: 'a@solv.sg', password: 'password123', name: 'A' });
  });

  test('a case priced only in the base currency exports, and so does an empty one', async () => {
    const r = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Local' });
    const e = store.createExpense({ companyId: u.companyId, userId: u.id, status: 'reviewed', merchant: 'Grab', currency: 'SGD', total: 18.4, receiptDate: '2026-09-05',
      lines: [{ category: 'Meals', amount: 18.4, baseAmount: 18.4, fxRate: 1, fxSource: 'base' }] });
    reports.addExpense(r.id, e.id);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await exp.xlsxBuffer(await payload(r.id)));
    expect(wb.getWorksheet('Rates').getRow(2).getCell(1).value).toMatch(/Every line is in SGD/);
    const empty = reports.createReport({ companyId: u.companyId, userId: u.id, title: 'Empty' });
    expect((await exp.xlsxBuffer(await payload(empty.id))).length).toBeGreaterThan(1000);
  });
});
