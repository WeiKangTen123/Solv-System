// Prices a saved folio read (samples/reads/*.json) with the live providers:
//   node main/scripts/fx-sample.js samples/reads/courtyard-marriott-pune.json
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const fs = require('fs');
require('../db/migrate').run();
const rates = require('../fx/rates');
const { toBase } = require('../fx/apply');

(async () => {
  for (const file of process.argv.slice(2)) {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rate = await rates.getRate({ from: r.currency, to: 'SGD', date: r.date });
    const lines = r.lines.map(l => ({ category: l.category, onBehalfOf: l.onBehalfOf, amount: l.amount, base: rate ? toBase(l.amount, rate.rate) : null }));
    const baseTotal = rate ? Math.round(lines.reduce((s, l) => s + Math.round(l.base * 100), 0)) / 100 : null;
    console.log(JSON.stringify({ file, receiptDate: r.date, currency: r.currency, total: r.total, rate, lines, baseTotal, wholeReceiptBase: rate ? toBase(r.total, rate.rate) : null }, null, 1));
  }
})().catch(err => { console.error(err); process.exit(1); });
