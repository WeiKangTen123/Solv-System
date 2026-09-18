// Reads one receipt file through the real reader and prints what Solv would
// store. Needs a Gemini key: Gemini_API_KEY in main/.env or the environment.
//   node main/scripts/read-sample.js "Sample/jw marriott mumbai.pdf"
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const fs = require('fs');
const path = require('path');
const { readOne, buildLines } = require('../receipts/read-receipt');

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node main/scripts/read-sample.js <file.pdf|jpg>'); process.exit(1); }
  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.pdf' ? 'application/pdf' : (ext === '.png' ? 'image/png' : 'image/jpeg');
  const t0 = Date.now();
  const r = await readOne(null, buffer, mime);
  if (!r) { console.log(JSON.stringify({ file, read: false }, null, 2)); process.exit(2); }
  const lines = buildLines(r, 'Other');
  console.log(JSON.stringify({ file, seconds: (Date.now() - t0) / 1000, merchant: r.merchant, date: r.date, time: r.time, invoiceNumber: r.invoiceNumber,
    currency: r.currency, total: r.total, tax: r.tax, subTotal: r.subTotal, category: r.category, confidence: r.confidence, description: r.description,
    lineItems: r.lineItems, lines }, null, 2));
})().catch(err => { console.error(err); process.exit(1); });
