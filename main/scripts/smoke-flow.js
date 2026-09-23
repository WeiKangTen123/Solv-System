// Drives the whole flow through the HTTP API against a freshly started
// production server: register, add staff, upload a scanned folio, wait for
// the read, review it, create and file a case, claim it, export the
// PDF through the signed link, and dry-run the Xero bill. Needs a reader key
// in main/.env. Prints one line per step; exits non-zero on the first failure.
//   node main/scripts/smoke-flow.js
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const ROOT = path.join(__dirname, '../..');
const PORT = 4019;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'solv-smoke-'));
const env = { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATA_DIR: DATA, LOGS_DIR: path.join(DATA, 'logs'), ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '0'.repeat(64), JWT_SECRET: process.env.JWT_SECRET || 'smoke' };
const server = spawn(process.execPath, ['main/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', d => { log += d; }); server.stderr.on('data', d => { log += d; });

const base = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(method, p, { token, body, raw } = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return res;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${json.error || ''}`);
  return json;
}
const step = (n, msg) => console.log(`${String(n).padStart(2)}. ${msg}`);

(async () => {
  for (let i = 0; i < 40; i++) { try { await fetch(base + '/dashboard/health'); break; } catch { await sleep(250); } }
  step(1, 'server up; UI served: ' + /<title>Solv Expenses<\/title>/.test(await (await fetch(base + '/')).text()));

  const admin = await call('POST', '/api/auth/register', { body: { email: 'admin@solv.sg', password: 'password123', name: 'Wei Kang' } });
  step(2, `registered admin ${admin.user.email} (company created, role ${admin.user.role})`);
  const A = admin.token;
  const elaine = (await call('POST', '/api/users', { token: A, body: { email: 'elaine@solv.sg', password: 'password123', name: 'Elaine Xin Yu Khoo', department: 'Sales', employeeId: 'S0042' } })).user;
  const marcus = (await call('POST', '/api/users', { token: A, body: { email: 'marcus@solv.sg', password: 'password123', name: 'Marcus Tan' } })).user;
  step(3, `staff added: ${elaine.name} (${elaine.role}), ${marcus.name} (${marcus.role}) — everyone does the same job`);
  const E = (await call('POST', '/api/auth/login', { body: { email: 'elaine@solv.sg', password: 'password123' } })).token;
  const M = (await call('POST', '/api/auth/login', { body: { email: 'marcus@solv.sg', password: 'password123' } })).token;

  const pdf = fs.readFileSync(path.join(ROOT, 'samples/receipts/jw-marriott-mumbai.pdf'));
  const up = await call('POST', '/api/receipts', { token: E, body: { mime: 'application/pdf', data: pdf.toString('base64'), filename: 'jw marriott mumbai.pdf' } });
  step(4, `uploaded the Mumbai folio as Elaine: expense ${up.expense.id} (${up.expense.status})`);
  let exp;
  for (let i = 0; i < 40; i++) { exp = (await call('GET', `/api/expenses/${up.expense.id}`, { token: E })).expense; if (exp.status !== 'reading') break; await sleep(3000); }
  if (exp.status === 'reading') throw new Error('the read did not finish in two minutes');
  step(5, `read: ${exp.merchant} · ${exp.currency} ${exp.total} · tax ${exp.tax} · ${exp.lines.length} lines · base ${exp.baseTotal} SGD (${exp.lines[0] && exp.lines[0].fxSource} ${exp.lines[0] && exp.lines[0].fxRate})`);
  // The figures have to be exact; the merchant's wording is the model's, and it
  // has said both "JW Marriott Mumbai Sahar" and "JW Marriott Hotel Mumbai
  // Sahar" for the same folio. Pinning the whole string failed a good run.
  if (!/JW Marriott.*Mumbai/i.test(exp.merchant || '')) throw new Error(`unexpected merchant: ${exp.merchant}`);
  if (exp.total !== 44309 || exp.currency !== 'INR') throw new Error(`unexpected read: ${exp.currency} ${exp.total}`);
  if (!(exp.baseTotal > 0)) throw new Error('the expense was not priced');

  await call('PATCH', `/api/expenses/${exp.id}`, { token: E, body: { purpose: 'Client meetings, Mumbai office' } });
  const reviewed = await call('PATCH', `/api/expenses/${exp.id}/status`, { token: E, body: { status: 'reviewed' } });
  step(6, `reviewed with a purpose: ${reviewed.expense.status}`);

  const report = (await call('POST', '/api/reports', { token: E, body: { title: 'India trip, Sep 2026', purpose: 'Client site visits, India', periodFrom: '2026-08-31', periodTo: '2026-09-04', destination: 'Mumbai and Pune, India', nights: 4 } })).report;
  const filed = await call('POST', `/api/reports/${report.id}/expenses`, { token: E, body: { expenseIds: [exp.id] } });
  step(7, `case ${report.number} created and filed: ${filed.report.expenses.length} receipt, total SGD ${filed.report.totals.totalBase}, status ${filed.report.status}`);

  try { await call('POST', `/api/reports/${report.id}/claimed`, { token: M }); throw new Error("a colleague claimed Elaine's case"); } catch (e) { if (!/403|404|claimant/.test(e.message)) throw e; }
  const claimed = await call('POST', `/api/reports/${report.id}/claimed`, { token: E });
  step(8, `Elaine marked it claimed: ${claimed.report.status}; Marcus could not (refused)`);
  try { await call('PATCH', `/api/expenses/${exp.id}`, { token: E, body: { purpose: 'x' } }); throw new Error('a locked expense was edited'); } catch (e) { if (!/409/.test(e.message)) throw e; }
  const reopened = await call('POST', `/api/reports/${report.id}/reopen`, { token: E });
  const again = await call('POST', `/api/reports/${report.id}/claimed`, { token: E });
  step(9, `a claimed case locks its receipts; reopened (${reopened.report.status}) and claimed again (${again.report.status})`);

  const link = await call('GET', `/api/reports/${report.id}/export-url?format=pdf`, { token: A });
  const res = await call('GET', link.url, { raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  step(10, `the admin exported the PDF through the signed link: ${res.status} ${res.headers.get('content-type')} · ${buf.length} bytes · ${pages} pages (report + 2 receipt pages)`);
  if (!buf.toString('latin1').startsWith('%PDF') || pages !== 3) throw new Error('unexpected PDF');

  const dry = await call('POST', `/api/reports/${report.id}/post?dryRun=1`, { token: A });
  step(11, `Xero dry run: ${dry.bill.invoice.lineItems.length} lines, ${dry.bill.invoice.currencyCode} ${dry.bill.total}, contact ${dry.bill.contact.name}, org ${dry.tenantName || 'none connected'}`);
  const hist = (await call('GET', `/api/reports/${report.id}/events`, { token: E })).events.map(e => e.action).join(' → ');
  step(12, `history: ${hist}`);

  const errors = (log.match(/error/gi) || []).length;
  step(13, `server log: ${errors} error lines`);
  console.log('SMOKE OK');
})().catch(err => { console.error('SMOKE FAILED:', err.message); console.error(log.split('\n').filter(l => /error|warn/i.test(l)).slice(-10).join('\n')); process.exitCode = 1; })
  .finally(() => { server.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });
