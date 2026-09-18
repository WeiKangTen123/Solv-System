// Builds the real expense report from the two Marriott folios, end to end, in
// a throwaway data directory: Elaine files both expenses, submits, Henry
// approves, and the PDF, XLSX and CSV land in docs/acceptance/.
//   node main/scripts/demo-report.js
// Expenses come from the saved reader output (docs/acceptance/*.json) so no
// model call is needed; the exchange rate is fetched live.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'solv-demo-'));
process.env.LOGS_DIR = path.join(process.env.DATA_DIR, 'logs');
process.env.LOG_LEVEL = 'warn';
process.env.NODE_ENV = 'development';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'demo';
require('../db/migrate').run();

const users = require('../utils/users');
const store = require('../store/expenses');
const reports = require('../store/reports');
const wf = require('../reports/workflow');
const receiptStore = require('../utils/receipt-store');
const { hashBuffer } = require('../intake/dedup');
const { applyFx } = require('../fx/apply');
const { reportPayload } = require('../reports/expense-payload');
const exporter = require('../reports/expense-export');
const doc = require('../reports/expense-doc');
const { newId } = require('../utils/ids');

const ROOT = path.join(__dirname, '../..');
const SAMPLES = [
  { json: 'docs/acceptance/2026-09-18-jw-marriott-mumbai.json', pdf: 'Sample/jw marriott mumbai.pdf', purpose: 'Client meetings, Mumbai office' },
  { json: 'docs/acceptance/2026-09-18-courtyard-marriott-pune.json', pdf: 'Sample/courtyard marriott pune.pdf', purpose: 'Client site visit, Chakan plant' },
];

(async () => {
  const admin = await users.createUser({ email: 'admin@solv.sg', password: 'password123', name: 'Wei Kang' });
  users.updateCompany(admin.companyId, { name: 'Solv Pte Ltd' });
  const henry = await users.createUser({ email: 'henry@solv.sg', password: 'password123', companyId: admin.companyId, role: 'manager', name: 'Henry Bennett', department: 'Sales' });
  const elaine = await users.createUser({ email: 'elaine@solv.sg', password: 'password123', companyId: admin.companyId, name: 'Elaine Xin Yu Khoo', department: 'Sales', employeeId: 'S0042', managerId: henry.id });

  const report = reports.createReport({ companyId: admin.companyId, userId: elaine.id, title: 'India trip, Sep 2026', purpose: 'Client site visits, India', periodFrom: '2026-08-31', periodTo: '2026-09-04', destination: 'Mumbai and Pune, India', nights: 4 });

  for (const s of SAMPLES) {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, s.json), 'utf8'));
    const pdf = fs.readFileSync(path.join(ROOT, s.pdf));
    const receiptId = newId();
    const file = receiptStore.forUser(elaine.id).save(receiptId, pdf, 'application/pdf');
    store.createReceipt({ id: receiptId, companyId: admin.companyId, userId: elaine.id, file, mime: 'application/pdf', sizeBytes: pdf.length, sha256: hashBuffer(pdf), pages: null, source: 'upload', originalName: path.basename(s.pdf) });
    const e = store.createExpense({
      companyId: admin.companyId, userId: elaine.id, receiptId, source: 'upload', status: 'reviewed',
      merchant: r.merchant, receiptDate: r.date, receiptTime: r.time, invoiceNo: r.invoiceNumber, currency: r.currency, total: r.total, tax: r.tax,
      description: r.description, category: r.category, purpose: s.purpose, aiReadAt: new Date().toISOString(), aiConfidence: r.confidence,
      lines: r.lines.map(l => ({ category: l.category, description: l.description, amount: l.amount, onBehalfOf: l.onBehalfOf, currency: r.currency })),
    });
    const fx = await applyFx(e.id);
    if (fx.pending) throw new Error(`No rate for ${r.currency} on ${r.date}`);
    reports.addExpense(report.id, e.id);
  }

  wf.submit(report.id, elaine);
  wf.approve(report.id, henry);

  const payload = await reportPayload(report.id, { withReceipts: true });
  const name = doc.exportFilename(payload);
  const outDir = path.join(ROOT, 'docs/acceptance');
  const pdfBuf = await exporter.pdfBuffer(doc.expenseReportDoc(payload));
  fs.writeFileSync(path.join(outDir, `${name}.pdf`), pdfBuf);
  fs.writeFileSync(path.join(outDir, `${name}.xlsx`), await exporter.xlsxBuffer(payload));
  fs.writeFileSync(path.join(outDir, `${name}.csv`), exporter.csvText(payload));

  const m = doc.buildModel(payload);
  const pages = (pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log(JSON.stringify({
    report: report.number, status: reports.getReport(report.id).status, files: [`${name}.pdf`, `${name}.xlsx`, `${name}.csv`],
    pdfBytes: pdfBuf.length, pdfPages: pages, receiptPages: payload.receipts.map(r => `${r.ref}: ${r.pages.length}`),
    columns: m.columns, categoryTotals: m.categoryTotals, total: m.total, reimbursement: m.reimbursement, rateNotes: m.rateNotes, notes: m.notes,
    lines: m.rows.map(r => `${r.n}. ${r.date} ${r.description.slice(0, 60)} ${r.currency} ${r.amount} × ${r.rate} = ${r.base}`),
  }, null, 1));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
})().catch(err => { console.error(err); process.exit(1); });
