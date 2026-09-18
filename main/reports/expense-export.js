const ExcelJS = require('exceljs');
const doc = require('./expense-doc');

// The thin part that calls libraries. Helvetica is a standard PDF font every
// reader resolves itself, so no font file is embedded (see the Xero app's
// budget export for the reasoning); text is folded to Latin-1 in expense-doc.
const FONTS = { Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } };
let _printer = null;
function printer() { if (!_printer) { const PdfPrinter = require('pdfmake'); _printer = new PdfPrinter(FONTS); } return _printer; }

function pdfBuffer(definition) {
  return new Promise((resolve, reject) => {
    const pdf = printer().createPdfKitDocument(definition);
    const chunks = [];
    pdf.on('data', c => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

// Numbers land as numbers with a display format, never as strings: a sheet
// finance cannot sum defeats the point of a spreadsheet.
const MONEY_FMT = '#,##0.00;(#,##0.00);"–"';
async function xlsxBuffer(payload) {
  const model = doc.workbookModel(payload);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Solv Expenses';
  wb.created = new Date(payload.generatedAt || Date.now());
  for (const s of model.sheets) {
    const sheet = wb.addWorksheet(s.name);
    if (s.header) { sheet.addRow(s.header).font = { bold: true }; sheet.views = [{ state: 'frozen', ySplit: 1 }]; }
    for (const r of s.rows) sheet.addRow(r);
    if (s.money) for (let i = 2; i <= s.rows.length + 1; i++) for (const c of s.money) sheet.getRow(i).getCell(c).numFmt = MONEY_FMT;
    if (s.total !== undefined && s.header) {
      const col = s.header.length - 1;                         // the base-currency column
      const letter = sheet.getColumn(col).letter;
      const row = sheet.addRow([]);
      row.getCell(col - 1).value = s.totalLabel;
      row.getCell(col).value = { formula: `SUM(${letter}2:${letter}${s.rows.length + 1})`, result: s.total };
      row.getCell(col).numFmt = MONEY_FMT;
      row.font = { bold: true };
    }
    sheet.columns.forEach(c => { c.width = Math.min(48, Math.max(10, ...(c.values || []).map(v => String(v ?? '').length + 2))); });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { pdfBuffer, xlsxBuffer, csvText: doc.expenseReportCsv, FONTS };
