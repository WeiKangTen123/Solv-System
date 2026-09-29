// Test script: Creates a claim case with the 2 receipts from samples/receipts/,
// processes them through Gemini API using the configured key, tests accuracy,
// and compares the two 500 RPD models (gemini-3.5-flash-lite vs gemini-3.1-flash-lite).
//
// Usage:
//   node main/scripts/test-receipt-case.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
process.env.NODE_ENV = 'development';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

require('../db/migrate').run();
const users = require('../store/users');
const store = require('../store/expenses');
const reports = require('../store/reports');
const receiptStore = require('../receipts/receipt-store');
const { renderPdfPages } = require('../pdf/render');
const parser = require('../receipts/receipt-parser');
const { parseLlmJson } = require('../llm/llm-json');
const { buildLines, applyRead } = require('../receipts/read-receipt');
const { newId } = require('../utils/ids');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const API_KEY = process.env.Gemini_API_KEY;
if (!API_KEY) {
  console.error('ERROR: No Gemini_API_KEY found in main/.env');
  process.exit(1);
}

const MODELS = [
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite (500 RPD)' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite (500 RPD)' }
];

const SAMPLES = [
  {
    name: 'JW Marriott Mumbai Sahar (2 pages)',
    pdfFile: path.join(__dirname, '../../samples/receipts/jw-marriott-mumbai.pdf'),
    expectedJson: path.join(__dirname, '../../samples/reads/jw-marriott-mumbai.json')
  },
  {
    name: 'Courtyard Marriott Pune Chakan (4 pages)',
    pdfFile: path.join(__dirname, '../../samples/receipts/courtyard-marriott-pune.pdf'),
    expectedJson: path.join(__dirname, '../../samples/reads/courtyard-marriott-pune.json')
  }
];

async function callGeminiDirect(model, messages, maxTokens = 6000) {
  const res = await axios.post(
    GEMINI_URL,
    {
      model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
    },
    {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 120_000,
    }
  );
  const choice = res.data.choices?.[0];
  if (!choice?.message?.content) throw new Error(`Empty response from ${model}`);
  return choice.message.content;
}

async function extractWithModel(modelId, renderedPages) {
  const content = [{
    type: 'text',
    text: `These ${renderedPages.length} images are the PAGES of ONE document (a hotel folio, an invoice or a statement), in order. ` +
          `Read them together as a single receipt and return { "receipts": [ one entry ] }: one merchant, one invoiceNumber, ` +
          `one total (the final amount charged, usually on the last page), one currency, EVERY line item from EVERY page, and no box_2d. ` +
          `Never return one entry per page.`
  }];

  renderedPages.forEach((p, i) => {
    content.push({ type: 'text', text: `Page ${i + 1} of ${renderedPages.length}:` });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${p.buffer.toString('base64')}` } });
  });

  const messages = [
    { role: 'system', content: parser.SYSTEM_PROMPT },
    { role: 'user', content }
  ];

  const t0 = Date.now();
  const raw = await callGeminiDirect(modelId, messages, 6000);
  const latencySec = ((Date.now() - t0) / 1000).toFixed(2);

  const parsed = parser.normaliseMany(parseLlmJson(raw));
  const rec = parsed?.receipts?.[0] || null;
  const lines = rec ? buildLines(rec, rec.category) : [];

  return { latencySec, rec, lines, raw };
}

async function run() {
  console.log('========================================================================');
  console.log('   SOLV SYSTEM - RECEIPT CLAIM CASE & ACCURACY EVALUATION (GEMINI)      ');
  console.log('========================================================================\n');

  console.log(`[1] Environment & Configuration:`);
  console.log(`    Gemini API Key: ${API_KEY.slice(0, 10)}...${API_KEY.slice(-4)}`);
  console.log(`    Evaluated Models (500 RPD Tier):`);
  MODELS.forEach(m => console.log(`      - ${m.name} [${m.id}]`));
  console.log(`    Receipts under test (from samples/receipts/):`);
  SAMPLES.forEach(s => console.log(`      - ${path.basename(s.pdfFile)}`));
  console.log('');

  // 1. Setup a test company and user
  const company = users.createCompany({ name: 'Solv Test Corp', baseCurrency: 'SGD' });
  const testEmail = `claim-test-${Date.now()}@solv.local`;
  const user = await users.createUser({ companyId: company.id, email: testEmail, password: 'Password123!', name: 'Aisha Rahman' });
  console.log(`[2] Created Claimant User: ${user.name} (${user.email}), Company: ${user.companyId} (${company.name})`);

  // 2. Create the claim case (report of kind 'case')
  const claimCase = reports.createReport({
    companyId: user.companyId,
    userId: user.id,
    kind: 'case',
    title: 'India Business Trip - Hotel Folios Claim Case',
    purpose: 'Client visits in Mumbai and Chakan Pune',
    destination: 'India (Mumbai & Pune)',
    notes: 'Hotel folios with room transfers for colleague Lim Wei Jie'
  });
  console.log(`[3] Created Expense Claim Case: "${claimCase.title}" (ID: ${claimCase.id}, Number: ${claimCase.number})\n`);

  // Pre-render the 2 receipts
  console.log(`[4] Pre-rendering PDF receipts to images for vision extraction...`);
  const renderedCache = [];
  for (const s of SAMPLES) {
    const buf = fs.readFileSync(s.pdfFile);
    const expected = JSON.parse(fs.readFileSync(s.expectedJson, 'utf8'));
    const t0 = Date.now();
    const rendered = await renderPdfPages(buf);
    console.log(`    - ${path.basename(s.pdfFile)}: ${rendered.pages.length} pages rendered in ${Date.now() - t0}ms`);
    renderedCache.push({ sample: s, buf, expected, rendered });
  }
  console.log('');

  // 3. Evaluate each model across both receipts
  console.log(`[5] Running Accuracy Evaluation on Both 500 RPD Models:`);
  const evalMatrix = [];

  for (const model of MODELS) {
    console.log(`\n  ==============================================================`);
    console.log(`  Evaluating Model: ${model.name}`);
    console.log(`  ==============================================================`);

    for (const item of renderedCache) {
      console.log(`  -> Processing: ${item.sample.name}...`);
      const res = await extractWithModel(model.id, item.rendered.pages);
      console.log(`     Response Time: ${res.latencySec}s`);

      const rec = res.rec;
      const exp = item.expected;

      if (!rec) {
        console.log(`     FAILED: Could not parse receipt.`);
        evalMatrix.push({ model: model.id, receipt: item.sample.name, success: false });
        continue;
      }

      const passMerchant = rec.merchant && (
        rec.merchant.toLowerCase().includes(exp.merchant.toLowerCase().slice(0, 15)) ||
        exp.merchant.toLowerCase().includes(rec.merchant.toLowerCase().slice(0, 15))
      );
      const passDate = rec.date === exp.date;
      const passInvoiceNo = rec.invoiceNumber === exp.invoiceNumber;
      const passCurrency = rec.currency === exp.currency;
      const passTotal = Math.abs((rec.total || 0) - exp.total) < 0.05;
      const passTax = Math.abs((rec.tax || 0) - (exp.tax || 0)) < 1.0;
      const passCategory = rec.category === exp.category;
      const linesSum = res.lines.reduce((s, l) => s + l.amount, 0);
      const passLinesReconcile = Math.abs(linesSum - (rec.total || 0)) < 0.05;

      const hasColleagueSplit = res.lines.some(l => l.onBehalfOf && l.onBehalfOf.includes('Lim Wei Jie'));

      console.log(`     - Merchant:      ${rec.merchant} (Expected: ${exp.merchant}) => [${passMerchant ? 'PASS' : 'FAIL'}]`);
      console.log(`     - Date:          ${rec.date} (Expected: ${exp.date}) => [${passDate ? 'PASS' : 'FAIL'}]`);
      console.log(`     - Invoice #:     ${rec.invoiceNumber} (Expected: ${exp.invoiceNumber}) => [${passInvoiceNo ? 'PASS' : 'FAIL'}]`);
      console.log(`     - Currency:      ${rec.currency} (Expected: ${exp.currency}) => [${passCurrency ? 'PASS' : 'FAIL'}]`);
      console.log(`     - Total Amount:  ${rec.total} ${rec.currency} (Expected: ${exp.total}) => [${passTotal ? 'PASS' : 'FAIL'}]`);
      console.log(`     - Tax:           ${rec.tax} ${rec.currency} (Expected: ${exp.tax}) => [${passTax ? 'PASS' : 'FAIL'}]`);
      console.log(`     - Category:      ${rec.category} => [${passCategory ? 'PASS' : 'FAIL'}]`);
      console.log(`     - Line Items:    ${rec.lineItems.length} items extracted from folio`);
      console.log(`     - Claim Lines:   ${res.lines.length} lines built, Sum: ${linesSum.toFixed(2)} ${rec.currency} => [${passLinesReconcile ? 'RECONCILED' : 'DISCREPANCY'}]`);
      console.log(`     - Colleague:     ${hasColleagueSplit ? 'Lim Wei Jie split DETECTED' : 'Not detected'} => [${hasColleagueSplit ? 'PASS' : 'FAIL'}]`);

      evalMatrix.push({
        model: model.id,
        modelName: model.name,
        receipt: item.sample.name,
        latencySec: res.latencySec,
        passMerchant,
        passDate,
        passInvoiceNo,
        passCurrency,
        passTotal,
        passTax,
        passCategory,
        passLinesReconcile,
        hasColleagueSplit,
        allKeyFieldsPass: passMerchant && passDate && passInvoiceNo && passCurrency && passTotal && passTax && passLinesReconcile && hasColleagueSplit,
        extracted: {
          merchant: rec.merchant,
          date: rec.date,
          invoiceNumber: rec.invoiceNumber,
          currency: rec.currency,
          total: rec.total,
          tax: rec.tax,
          lineItemsCount: rec.lineItems.length,
          claimLinesCount: res.lines.length,
          claimLinesSum: linesSum
        },
        rec,
        lines: res.lines
      });

      // Brief delay to be polite to rate limits
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // 4. File the receipts into the claim case using gemini-3.5-flash-lite
  console.log(`\n[6] Filing Receipts into the Claim Case using gemini-3.5-flash-lite:`);
  const filedExpenses = [];
  const primaryResults = evalMatrix.filter(m => m.model === 'gemini-3.5-flash-lite');

  for (let i = 0; i < renderedCache.length; i++) {
    const item = renderedCache[i];
    const rEval = primaryResults[i];
    const receiptId = newId();

    const storedFile = receiptStore.forUser(user.id).save(receiptId, item.buf, 'application/pdf');
    store.createReceipt({
      id: receiptId,
      companyId: user.companyId,
      userId: user.id,
      file: storedFile,
      mime: 'application/pdf',
      sizeBytes: item.buf.length,
      originalName: path.basename(item.sample.pdfFile)
    });

    const expenseRow = store.createExpense({
      companyId: user.companyId,
      userId: user.id,
      receiptId: receiptId,
      source: 'upload',
      status: 'reading',
      currency: rEval.rec.currency || 'INR'
    });

    // Add to the claim case
    reports.addExpense(claimCase.id, expenseRow.id);

    // Apply the extracted read
    await applyRead(expenseRow.id, rEval.rec);

    // Mark as reviewed
    store.updateExpense(expenseRow.id, {
      status: 'reviewed',
      purpose: `Hotel stay & meals for ${item.sample.name.split(' (')[0]}`
    });

    const updatedExpense = store.getExpense(expenseRow.id);
    filedExpenses.push(updatedExpense);
    console.log(`    + Added Expense ${expenseRow.id} to Case:`);
    console.log(`      Merchant: ${updatedExpense.merchant}`);
    console.log(`      Date: ${updatedExpense.receiptDate}`);
    console.log(`      Original: ${updatedExpense.total} ${updatedExpense.currency}`);
    console.log(`      Base (SGD): $${updatedExpense.baseAmount ?? 'pending FX'}`);
    console.log(`      Claim Lines: ${updatedExpense.lines.length} lines`);
    updatedExpense.lines.forEach(l => {
      console.log(`        * [${l.category}] ${l.description || 'Charges'} - ${l.amount} ${updatedExpense.currency} (Base: $${l.baseAmount ?? 'N/A'} SGD) ${l.onBehalfOf ? `[For: ${l.onBehalfOf}]` : ''}`);
    });
  }

  // 5. Inspect final Case Totals
  const finalCase = reports.getReport(claimCase.id);
  console.log(`\n[7] Claim Case Status Summary:`);
  console.log(`    Case Title:         ${finalCase.title}`);
  console.log(`    Case Number:        ${finalCase.number}`);
  console.log(`    Total Receipts:     ${finalCase.expenses.length}`);
  console.log(`    Total Claim Lines:  ${finalCase.totals.lineCount}`);
  console.log(`    Total Base (SGD):   $${finalCase.totals.totalBase}`);
  console.log(`    Reimbursement (SGD):$${finalCase.totals.reimbursement}`);
  console.log(`    Pending Rates:      ${finalCase.totals.pendingRates}`);
  console.log(`    Unreviewed Items:   ${finalCase.totals.unreviewed} (0 = ready to claim)`);
  console.log(`    Breakdown by Category:`);
  for (const [cat, amt] of Object.entries(finalCase.totals.byCategory)) {
    console.log(`      - ${cat}: $${amt} SGD`);
  }

  // 6. Summary Comparison Table
  console.log(`\n========================================================================`);
  console.log(`   FINAL ACCURACY COMPARISON TABLE (2 MODELS WITH 500 RPD)              `);
  console.log(`========================================================================`);
  console.log(
    'Model'.padEnd(25) + ' | ' +
    'Receipt'.padEnd(30) + ' | ' +
    'Time'.padEnd(7) + ' | ' +
    'Merchant'.padEnd(8) + ' | ' +
    'Date'.padEnd(6) + ' | ' +
    'Total'.padEnd(8) + ' | ' +
    'Tax'.padEnd(6) + ' | ' +
    'Split'.padEnd(6) + ' | ' +
    'Overall'
  );
  console.log('-'.repeat(110));
  for (const row of evalMatrix) {
    console.log(
      row.model.padEnd(25) + ' | ' +
      row.receipt.slice(0, 28).padEnd(30) + ' | ' +
      (row.latencySec + 's').padEnd(7) + ' | ' +
      (row.passMerchant ? 'PASS' : 'FAIL').padEnd(8) + ' | ' +
      (row.passDate ? 'PASS' : 'FAIL').padEnd(6) + ' | ' +
      (row.passTotal ? 'PASS' : 'FAIL').padEnd(8) + ' | ' +
      (row.passTax ? 'PASS' : 'FAIL').padEnd(6) + ' | ' +
      (row.hasColleagueSplit ? 'PASS' : 'FAIL').padEnd(6) + ' | ' +
      (row.allKeyFieldsPass ? 'ACCURATE (100%)' : 'PARTIAL')
    );
  }
  console.log('========================================================================\n');
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
