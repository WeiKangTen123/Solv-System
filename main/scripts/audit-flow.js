// Exercises every HTTP route against a freshly started production server and
// reports which ones work. Where smoke-flow.js proves the happy path end to
// end and stops at the first failure, this one keeps going and checks the
// edges too: who is refused, what a bad input returns, what happens to a
// locked record. It prints one line per check, then the failures, then which
// routes were never reached.
//
//   node main/scripts/audit-flow.js            every check
//   node main/scripts/audit-flow.js --no-model  skip the checks that call the reader
//
// Needs a reader key in main/.env for the full run. Exits non-zero if any
// check failed.
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const ROOT = path.join(__dirname, '../..');
const PORT = 4021;
const NO_MODEL = process.argv.includes('--no-model');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'solv-audit-'));
const env = {
  ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATA_DIR: DATA,
  LOGS_DIR: path.join(DATA, 'logs'),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '0'.repeat(64),
  JWT_SECRET: process.env.JWT_SECRET || 'audit',
};
const server = spawn(process.execPath, ['main/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

const base = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── route coverage ────────────────────────────────────────────────────────
const HIT = new Set();
const ID_RE = /^(\d{10,}[a-z0-9]*|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/;
function tagOf(method, p) {
  const [pathname] = p.split('?');
  const parts = pathname.split('/').map(seg => {
    if (!seg) return seg;
    if (ID_RE.test(seg)) return ':id';
    if (seg.length > 20) return ':token';
    return seg;
  });
  return `${method} ${parts.join('/')}`;
}

async function call(method, p, { token, body, raw, tag } = {}) {
  HIT.add(tag || tagOf(method, p));
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  if (raw) return res;
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { _text: text.slice(0, 200) }; }
  return { status: res.status, json, headers: res.headers };
}

// ── checks ────────────────────────────────────────────────────────────────
const results = [];
let group = '';
function section(name) { group = name; console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`); }
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ group, name, ok: true });
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`);
  } catch (err) {
    results.push({ group, name, ok: false, err: err.message });
    console.log(`  FAIL ${name}  ${err.message}`);
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }
function expectStatus(r, want, what) {
  const list = Array.isArray(want) ? want : [want];
  expect(list.includes(r.status), `${what}: got ${r.status} ${JSON.stringify(r.json).slice(0, 120)}, wanted ${list.join(' or ')}`);
  return r;
}

(async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/dashboard/health'); break; } catch { await sleep(250); } }

  const S = {}; // shared state between sections

  // ── 1. health and auth ──────────────────────────────────────────────────
  section('Health and authentication');

  await check('GET /api/dashboard/health answers', async () => {
    const r = await call('GET', '/api/dashboard/health');
    expectStatus(r, 200, 'health');
    return `status ${r.json.status || 'ok'}`;
  });

  await check('the built UI is served', async () => {
    const res = await fetch(base + '/');
    const html = await res.text();
    expect(/<title>Solv Expenses<\/title>/.test(html), 'index.html did not come back');
    expect(/data-theme/.test(html), 'the theme stamp is missing from index.html');
  });

  await check('GET /api/auth/status reports an empty system', async () => {
    const r = await call('GET', '/api/auth/status');
    expectStatus(r, 200, 'status');
    expect(r.json.hasUsers === false, 'hasUsers should be false on a fresh database');
  });

  await check('POST /api/auth/register creates the admin and the company', async () => {
    const r = await call('POST', '/api/auth/register', { body: { email: 'admin@solv.sg', password: 'password123', name: 'Wei Kang' } });
    expectStatus(r, [200, 201], 'register');
    expect(r.json.user.role === 'admin', `first user should be admin, got ${r.json.user.role}`);
    S.A = r.json.token; S.admin = r.json.user;
    return `role ${r.json.user.role}`;
  });

  await check('a second self-registration is refused', async () => {
    const r = await call('POST', '/api/auth/register', { body: { email: 'stranger@solv.sg', password: 'password123', name: 'Stranger' } });
    expectStatus(r, [400, 403], 'second register');
    expect(typeof r.json.error === 'string' && r.json.error.length > 5, 'the refusal should carry a sentence');
    return r.json.error.slice(0, 48);
  });

  await check('GET /api/auth/me returns the signed-in user', async () => {
    const r = await call('GET', '/api/auth/me', { token: S.A });
    expectStatus(r, 200, 'me');
    expect(r.json.user.email === 'admin@solv.sg', 'wrong user came back');
  });

  await check('a wrong password is refused', async () => {
    const r = await call('POST', '/api/auth/login', { body: { email: 'admin@solv.sg', password: 'nope' } });
    expectStatus(r, 401, 'bad login');
  });

  await check('no token is 401, a malformed token is 401', async () => {
    expectStatus(await call('GET', '/api/expenses'), 401, 'no token');
    expectStatus(await call('GET', '/api/expenses', { token: 'not-a-jwt' }), 401, 'bad token');
  });

  // ── 2. users ────────────────────────────────────────────────────────────
  section('Staff and roles');

  await check('POST /api/users adds a manager, an employee and finance', async () => {
    const mk = body => call('POST', '/api/users', { token: S.A, body });
    const h = await mk({ email: 'henry@solv.sg', password: 'password123', name: 'Henry Bennett', role: 'manager' });
    expectStatus(h, [200, 201], 'create manager');
    S.henry = h.json.user;
    const e = await mk({ email: 'elaine@solv.sg', password: 'password123', name: 'Elaine Khoo', department: 'Sales', employeeId: 'S0042', managerId: S.henry.id });
    expectStatus(e, [200, 201], 'create employee');
    S.elaine = e.json.user;
    expect(S.elaine.managerId === S.henry.id, 'the manager link was not stored');
    const f = await mk({ email: 'finance@solv.sg', password: 'password123', name: 'Fiona Finance', role: 'finance' });
    expectStatus(f, [200, 201], 'create finance');
    S.fin = f.json.user;
    return '3 added';
  });

  await check('everyone can log in', async () => {
    for (const [k, email] of [['E', 'elaine@solv.sg'], ['H', 'henry@solv.sg'], ['F', 'finance@solv.sg']]) {
      const r = await call('POST', '/api/auth/login', { body: { email, password: 'password123' } });
      expectStatus(r, 200, `login ${email}`);
      S[k] = r.json.token;
    }
  });

  await check('GET /api/users lists staff for an admin', async () => {
    const r = await call('GET', '/api/users', { token: S.A });
    expectStatus(r, 200, 'list users');
    expect(r.json.users.length === 4, `expected 4 users, got ${r.json.users.length}`);
    expect(!JSON.stringify(r.json.users).includes('passwordHash'), 'a password hash leaked into the list');
    return `${r.json.users.length} users, no hashes`;
  });

  await check('an employee cannot create staff', async () => {
    const r = await call('POST', '/api/users', { token: S.E, body: { email: 'x@solv.sg', password: 'password123', name: 'X' } });
    expectStatus(r, 403, 'employee creating staff');
  });

  await check('PATCH /api/users/:id updates a profile', async () => {
    const r = await call('PATCH', `/api/users/${S.elaine.id}`, { token: S.A, body: { department: 'Sales APAC' } });
    expectStatus(r, 200, 'patch user');
    expect(r.json.user.department === 'Sales APAC', 'the department did not change');
  });

  await check('an employee cannot change someone else', async () => {
    const r = await call('PATCH', `/api/users/${S.henry.id}`, { token: S.E, body: { department: 'Hacked' } });
    expectStatus(r, [403, 404], 'employee patching another user');
  });

  await check('POST /api/users/:id/password changes a password', async () => {
    expectStatus(await call('POST', `/api/users/${S.fin.id}/password`, { token: S.A, body: { password: 'newpassword1' } }), 200, 'set password');
    const ok = await call('POST', '/api/auth/login', { body: { email: 'finance@solv.sg', password: 'newpassword1' } });
    expectStatus(ok, 200, 'login with the new password');
    S.F = ok.json.token;
    expectStatus(await call('POST', '/api/auth/login', { body: { email: 'finance@solv.sg', password: 'password123' } }), 401, 'the old password still works');
  });

  await check('DELETE /api/users/:id removes a throwaway account', async () => {
    const t = await call('POST', '/api/users', { token: S.A, body: { email: 'temp@solv.sg', password: 'password123', name: 'Temp' } });
    expectStatus(t, [200, 201], 'create temp');
    expectStatus(await call('DELETE', `/api/users/${t.json.user.id}`, { token: S.A }), 200, 'delete temp');
    const after = await call('GET', '/api/users', { token: S.A });
    expect(!after.json.users.some(u => u.email === 'temp@solv.sg'), 'the deleted user is still listed');
  });

  // ── 3. company settings ─────────────────────────────────────────────────
  section('Company settings');

  await check('GET /api/company returns the company', async () => {
    const r = await call('GET', '/api/company', { token: S.A });
    expectStatus(r, 200, 'get company');
    expect(r.json.company.baseCurrency === 'SGD', `base currency should be SGD, got ${r.json.company.baseCurrency}`);
    S.columns = r.json.company.reportColumns;
    return `${r.json.company.name}, ${r.json.company.baseCurrency}, ${(S.columns || []).length} report columns`;
  });

  await check('PATCH /api/company saves a change', async () => {
    const r = await call('PATCH', '/api/company', { token: S.A, body: { name: 'Solv Pte Ltd', fxPolicy: 'receipt_date' } });
    expectStatus(r, 200, 'patch company');
    expect(r.json.company.name === 'Solv Pte Ltd', 'the name did not change');
  });

  await check('an employee cannot change company settings', async () => {
    expectStatus(await call('PATCH', '/api/company', { token: S.E, body: { name: 'Mine now' } }), 403, 'employee patching company');
  });

  await check('company API keys can be added, listed masked, and removed', async () => {
    const add = await call('POST', '/api/company/llm-keys', { token: S.A, body: { apiKey: 'AIzaSyTESTKEY000000000000000000000000000', label: 'audit' } });
    expectStatus(add, [200, 201], 'add key');
    const list = await call('GET', '/api/company/llm-keys', { token: S.A });
    expectStatus(list, 200, 'list keys');
    const body = JSON.stringify(list.json);
    expect(!body.includes('AIzaSyTESTKEY000000000000000000000000000'), 'the full API key came back to the client');
    const id = (list.json.keys || [])[0] && (list.json.keys[0].id);
    expect(id, 'the added key was not listed');
    expectStatus(await call('DELETE', `/api/company/llm-keys/${id}`, { token: S.A, tag: 'DELETE /api/company/llm-keys/:id' }), 200, 'delete key');
    return 'masked on read';
  });

  // ── 4. receipts and reading ─────────────────────────────────────────────
  section('Receipts and the reader');

  const mumbai = fs.readFileSync(path.join(ROOT, 'samples/receipts/jw-marriott-mumbai.pdf'));
  const pune = fs.readFileSync(path.join(ROOT, 'samples/receipts/courtyard-marriott-pune.pdf'));

  await check('an unsupported file type is refused', async () => {
    const r = await call('POST', '/api/receipts', { token: S.E, body: { mime: 'application/zip', data: Buffer.from('x').toString('base64'), filename: 'x.zip' } });
    expectStatus(r, 400, 'bad mime');
    expect(/Accepted/.test(r.json.error || ''), 'the refusal should list what is accepted');
  });

  await check('missing file data is refused', async () => {
    expectStatus(await call('POST', '/api/receipts', { token: S.E, body: { mime: 'application/pdf' } }), 400, 'no data');
  });

  if (!NO_MODEL) {
    await check('POST /api/receipts accepts a scanned folio', async () => {
      const r = await call('POST', '/api/receipts', { token: S.E, body: { mime: 'application/pdf', data: mumbai.toString('base64'), filename: 'jw marriott mumbai.pdf' } });
      expectStatus(r, 201, 'upload');
      S.exp1 = r.json.expense; S.rec1 = r.json.receipt; S.imageToken = r.json.imageToken;
      expect(r.json.expense.status === 'reading', `a fresh upload should be reading, got ${r.json.expense.status}`);
      return `expense ${r.json.expense.id}`;
    });

    await check('the reader finishes and fills the fields', async () => {
      let e;
      for (let i = 0; i < 40; i++) {
        e = (await call('GET', `/api/expenses/${S.exp1.id}`, { token: S.E })).json.expense;
        if (e.status !== 'reading') break;
        await sleep(3000);
      }
      expect(e.status !== 'reading', 'the read did not finish in two minutes');
      expect(e.merchant && e.total > 0, `merchant or total missing: ${e.merchant} / ${e.total}`);
      expect(e.lines.length > 0, 'no lines were built');
      expect(e.baseTotal > 0, 'no base amount was computed');
      S.exp1 = e;
      return `${e.merchant} ${e.currency} ${e.total} → SGD ${e.baseTotal}, ${e.lines.length} lines`;
    });

    await check('the same file uploaded twice is caught as a duplicate', async () => {
      const r = await call('POST', '/api/receipts', { token: S.E, body: { mime: 'application/pdf', data: mumbai.toString('base64'), filename: 'again.pdf' } });
      expectStatus(r, 409, 'duplicate upload');
      expect(r.json.receiptId, 'the duplicate response should name the receipt it matched');
      return r.json.error.slice(0, 52);
    });
  }

  await check('GET /api/receipts/:id/token issues a viewing token', async () => {
    if (!S.rec1) throw new Error('skipped: no receipt (model checks were skipped)');
    const r = await call('GET', `/api/receipts/${S.rec1.id}/token`, { token: S.E });
    expectStatus(r, 200, 'image token');
    expect(r.json.token, 'no token came back');
    S.imageToken = r.json.token;
  });

  await check('the receipt image is served with a valid token and refused without', async () => {
    if (!S.rec1) throw new Error('skipped: no receipt');
    const ok = await call('GET', `/api/receipts/${S.rec1.id}/image?token=${encodeURIComponent(S.imageToken)}`, { raw: true });
    expect(ok.status === 200, `image with a good token: ${ok.status}`);
    expect(/pdf|image/.test(ok.headers.get('content-type') || ''), `unexpected content type ${ok.headers.get('content-type')}`);
    const bad = await call('GET', `/api/receipts/${S.rec1.id}/image?token=rubbish`, { raw: true });
    expect(bad.status === 401 || bad.status === 403, `image with a bad token should be refused, got ${bad.status}`);
    return `served ${ok.headers.get('content-type')}`;
  });

  await check('a thumbnail is generated on request', async () => {
    if (!S.rec1) throw new Error('skipped: no receipt');
    const r = await call('GET', `/api/receipts/${S.rec1.id}/image?token=${encodeURIComponent(S.imageToken)}&w=240`, { raw: true });
    expect(r.status === 200, `thumbnail: ${r.status}`);
  });

  // ── 5. phone capture ────────────────────────────────────────────────────
  section('Phone capture by QR code');

  await check('POST /api/receipts/pair returns a code and a QR', async () => {
    const r = await call('POST', '/api/receipts/pair', { token: S.E });
    expectStatus(r, [200, 201], 'pair');
    expect(r.json.token && /<svg/.test(r.json.qrSvg || ''), 'no token or QR came back');
    S.pair = r.json.token;
    return `expires in ${Math.round((r.json.expiresInMs || 0) / 60000)} min, ${r.json.maxUploads} uploads`;
  });

  await check('the phone page resolves the pairing code', async () => {
    const r = await call('GET', `/api/receipts/capture/${S.pair}`, { tag: 'GET /api/receipts/capture/:id' });
    expectStatus(r, 200, 'capture page');
  });

  await check('the owner can see the pairing status', async () => {
    const r = await call('GET', `/api/receipts/pair/${S.pair}`, { token: S.E, tag: 'GET /api/receipts/pair/:id' });
    expectStatus(r, 200, 'pair status');
  });

  await check('another user cannot see someone else\'s pairing', async () => {
    expectStatus(await call('GET', `/api/receipts/pair/${S.pair}`, { token: S.H }), 404, 'stranger reading a pairing');
  });

  if (!NO_MODEL) {
    await check('a phone upload through the pairing code creates an expense', async () => {
      const r = await call('POST', `/api/receipts/capture/${S.pair}`, { tag: 'POST /api/receipts/capture/:id', body: { mime: 'application/pdf', data: pune.toString('base64'), filename: 'courtyard pune.pdf' } });
      expectStatus(r, 201, 'phone upload');
      S.exp2 = r.json.expense;
      return `expense ${r.json.expense.id} from the phone`;
    });

    await check('the desktop sees what the phone sent', async () => {
      const r = await call('GET', `/api/receipts/capture/${S.pair}/status`, { tag: 'GET /api/receipts/capture/:id/status' });
      expectStatus(r, 200, 'capture status');
      expect((r.json.receipts || []).length >= 1, 'the phone upload is not listed');
    });
  }

  await check('DELETE /api/receipts/pair/:token ends the session', async () => {
    expectStatus(await call('DELETE', `/api/receipts/pair/${S.pair}`, { token: S.E, tag: 'DELETE /api/receipts/pair/:id' }), 200, 'unpair');
    const after = await call('GET', `/api/receipts/capture/${S.pair}`);
    expectStatus(after, [401, 404, 410], 'a revoked pairing should be refused');
    expect(typeof after.json.error === 'string', 'the refusal should say what to do next');
    return after.json.error.slice(0, 46);
  });

  // ── 6. expenses ─────────────────────────────────────────────────────────
  section('Expenses');

  await check('GET /api/expenses lists my own', async () => {
    const r = await call('GET', '/api/expenses', { token: S.E });
    expectStatus(r, 200, 'list expenses');
    expect(Array.isArray(r.json.expenses), 'no list came back');
    return `${r.json.expenses.length} for Elaine`;
  });

  await check('the list filters by status, date and filing', async () => {
    for (const q of ['?status=reviewed', '?unfiled=1', '?from=2026-01-01&to=2026-12-31']) {
      const r = await call('GET', `/api/expenses${q}`, { token: S.E });
      expectStatus(r, 200, `list ${q}`);
    }
  });

  await check('an employee cannot read a colleague\'s expenses', async () => {
    const r = await call('GET', `/api/expenses?userId=${S.henry.id}`, { token: S.E });
    expectStatus(r, [403, 404], 'employee reading another user');
  });

  await check('finance can read across the company', async () => {
    const r = await call('GET', '/api/expenses?all=1', { token: S.F });
    expectStatus(r, 200, 'finance wide read');
  });

  await check('a manager can read a direct report\'s expenses', async () => {
    const r = await call('GET', `/api/expenses?userId=${S.elaine.id}`, { token: S.H });
    expectStatus(r, 200, 'manager reading a report');
  });

  if (!NO_MODEL) {
    await check('PATCH /api/expenses/:id edits the fields', async () => {
      const r = await call('PATCH', `/api/expenses/${S.exp1.id}`, { token: S.E, body: { purpose: 'Client meetings, Mumbai', category: 'Lodging' } });
      expectStatus(r, 200, 'patch expense');
      expect(r.json.expense.purpose === 'Client meetings, Mumbai', 'the purpose did not save');
    });

    await check('bad input is refused with a sentence', async () => {
      const bad = [
        [{ currency: 'rupees' }, 'currency'],
        [{ receiptDate: '4 Sep 2026' }, 'date'],
        [{ category: 'Yachts' }, 'category'],
        [{ total: -5 }, 'negative total'],
      ];
      for (const [body, what] of bad) {
        const r = await call('PATCH', `/api/expenses/${S.exp1.id}`, { token: S.E, body });
        expectStatus(r, 400, `bad ${what}`);
        expect(typeof r.json.error === 'string', `bad ${what} returned no sentence`);
      }
      return '4 rejections, each with a sentence';
    });

    await check('PUT /api/expenses/:id/lines replaces the split', async () => {
      const e = (await call('GET', `/api/expenses/${S.exp1.id}`, { token: S.E })).json.expense;
      const half = Math.round(e.total * 100 / 2) / 100;
      const lines = [
        { description: 'Room', category: 'Lodging', amount: half, currency: e.currency },
        { description: 'Meals', category: 'Meals', amount: Math.round((e.total - half) * 100) / 100, currency: e.currency },
      ];
      const r = await call('PUT', `/api/expenses/${S.exp1.id}/lines`, { token: S.E, body: { lines } });
      expectStatus(r, 200, 'put lines');
      expect(r.json.expense.lines.length === 2, `expected 2 lines, got ${r.json.expense.lines.length}`);
      const sum = r.json.expense.lines.reduce((s, l) => s + l.amount, 0);
      expect(Math.abs(sum - e.total) < 0.011, `the lines (${sum}) no longer sum to the total (${e.total})`);
      return `2 lines summing to ${sum}`;
    });

    await check('POST /api/expenses/:id/fx refreshes the rate', async () => {
      const r = await call('POST', `/api/expenses/${S.exp1.id}/fx`, { token: S.E });
      expectStatus(r, 200, 'refresh fx');
      expect(r.json.expense.baseTotal > 0, 'no base total after a refresh');
      return `SGD ${r.json.expense.baseTotal}`;
    });

    await check('PATCH /api/expenses/:id/fx takes a manual rate with a reason', async () => {
      const r = await call('PATCH', `/api/expenses/${S.exp1.id}/fx`, { token: S.F, body: { rate: 0.0135, reason: 'card statement' } });
      expectStatus(r, 200, 'override fx');
      const l = r.json.expense.lines[0];
      expect(Math.abs(l.fxRate - 0.0135) < 1e-9, `the rate did not stick: ${l.fxRate}`);
      expect(/manual/i.test(l.fxSource || ''), `the source should say manual, got ${l.fxSource}`);
      return `rate ${l.fxRate} from ${l.fxSource}`;
    });

    await check('an override without a reason is refused', async () => {
      const r = await call('PATCH', `/api/expenses/${S.exp1.id}/fx`, { token: S.F, body: { rate: 0.02 } });
      expectStatus(r, 400, 'override with no reason');
    });

    await check('PATCH /api/expenses/:id/status marks it reviewed', async () => {
      const r = await call('PATCH', `/api/expenses/${S.exp1.id}/status`, { token: S.E, body: { status: 'reviewed' } });
      expectStatus(r, 200, 'review');
      expect(r.json.expense.status === 'reviewed', `status is ${r.json.expense.status}`);
    });

    await check('an unknown status is refused', async () => {
      expectStatus(await call('PATCH', `/api/expenses/${S.exp1.id}/status`, { token: S.E, body: { status: 'lovely' } }), 400, 'bad status');
    });

    await check('GET /api/expenses/:id/group answers', async () => {
      expectStatus(await call('GET', `/api/expenses/${S.exp1.id}/group`, { token: S.E }), 200, 'group');
    });

    await check('POST /api/expenses/:id/merge refuses a nonsense target', async () => {
      const r = await call('POST', `/api/expenses/${S.exp1.id}/merge`, { token: S.E, body: { ids: ['no-such-expense'] } });
      expectStatus(r, [400, 404], 'merge with a bad id');
    });

    await check('POST /api/expenses/:id/reread reads the file again', async () => {
      if (!S.exp2) throw new Error('skipped: no second expense');
      const r = await call('POST', `/api/expenses/${S.exp2.id}/reread`, { token: S.E });
      expectStatus(r, [200, 202], 'reread');
      let e;
      for (let i = 0; i < 40; i++) {
        e = (await call('GET', `/api/expenses/${S.exp2.id}`, { token: S.E })).json.expense;
        if (e.status !== 'reading') break;
        await sleep(3000);
      }
      expect(e.status !== 'reading', 'the re-read did not finish');
      S.exp2 = e;
      return `${e.merchant} ${e.currency} ${e.total}`;
    });
  }

  await check('DELETE /api/expenses/:id removes an unfiled one', async () => {
    const r = await call('GET', '/api/expenses?unfiled=1', { token: S.E });
    const victim = (r.json.expenses || []).find(e => !e.reportId && (!S.exp1 || e.id !== S.exp1.id)) || null;
    if (!victim) return 'nothing unfiled to delete, skipped';
    expectStatus(await call('DELETE', `/api/expenses/${victim.id}`, { token: S.E }), 200, 'delete expense');
    const gone = await call('GET', `/api/expenses/${victim.id}`, { token: S.E });
    expectStatus(gone, 404, 'reading a deleted expense');
    return `deleted ${victim.merchant || victim.id}`;
  });

  // ── 7. exchange rates ───────────────────────────────────────────────────
  section('Exchange rates');

  await check('GET /api/fx/rate prices a currency', async () => {
    const r = await call('GET', '/api/fx/rate?from=INR&to=SGD', { token: S.E });
    expectStatus(r, 200, 'get rate');
    const q = r.json.rate && typeof r.json.rate === 'object' ? r.json.rate : r.json;
    expect(Number(q.rate) > 0, `no rate came back: ${JSON.stringify(r.json).slice(0, 90)}`);
    expect(q.rateDate, 'the rate came back without the date it is for');
    return `1 INR = ${q.rate} SGD from ${q.source} for ${q.rateDate}`;
  });

  await check('an unknown currency fails gracefully, not with a 500', async () => {
    const r = await call('GET', '/api/fx/rate?from=ZZZ&to=SGD', { token: S.E });
    expectStatus(r, [400, 404, 422, 502], 'unknown currency');
    expect(typeof r.json.error === 'string', 'no sentence explaining the failure');
    return r.json.error.slice(0, 50);
  });

  await check('GET /api/fx/rates lists what is cached', async () => {
    const r = await call('GET', '/api/fx/rates', { token: S.E });
    expectStatus(r, 200, 'list rates');
    expect(Array.isArray(r.json.rates), 'no rates array');
    return `${r.json.rates.length} cached`;
  });

  await check('finance can enter a manual rate, an employee cannot', async () => {
    const body = { from: 'INR', to: 'SGD', date: '2026-09-01', rate: 0.0134 };
    expectStatus(await call('POST', '/api/fx/rates', { token: S.E, body }), 403, 'employee entering a rate');
    expectStatus(await call('POST', '/api/fx/rates', { token: S.F, body }), [200, 201], 'finance entering a rate');
  });

  await check('DELETE /api/fx/rates removes a manual rate', async () => {
    expectStatus(await call('DELETE', '/api/fx/rates?from=INR&to=SGD&date=2026-09-01', { token: S.F }), 200, 'delete rate');
  });

  // ── 8. reports ──────────────────────────────────────────────────────────
  section('Reports, approval and export');

  await check('POST /api/reports numbers a new report', async () => {
    const r = await call('POST', '/api/reports', { token: S.E, body: { title: 'India trip, Sep 2026', purpose: 'Client site visits', periodFrom: '2026-08-31', periodTo: '2026-09-04', destination: 'Mumbai and Pune', nights: 4 } });
    expectStatus(r, [200, 201], 'create report');
    S.report = r.json.report;
    expect(/^EXP-\d{4}-\d{4}$/.test(r.json.report.number), `unexpected number ${r.json.report.number}`);
    return r.json.report.number;
  });

  await check('a bad cover date is refused', async () => {
    expectStatus(await call('PATCH', `/api/reports/${S.report.id}`, { token: S.E, body: { periodFrom: '31 Aug' } }), 400, 'bad date');
  });

  await check('PATCH /api/reports/:id saves the cover', async () => {
    const r = await call('PATCH', `/api/reports/${S.report.id}`, { token: S.E, body: { advances: 100, notes: 'Paid by company card where marked' } });
    expectStatus(r, 200, 'patch cover');
  });

  if (!NO_MODEL) {
    await check('POST /api/reports/:id/expenses files reviewed expenses and skips the rest', async () => {
      const r = await call('POST', `/api/reports/${S.report.id}/expenses`, { token: S.E, body: { expenseIds: [S.exp1.id, S.exp2 ? S.exp2.id : S.exp1.id] } });
      expectStatus(r, 200, 'file expenses');
      expect(r.json.report.expenses.length >= 1, 'nothing was filed');
      return `${r.json.report.expenses.length} filed, ${(r.json.skipped || []).length} skipped`;
    });

    await check('DELETE /api/reports/:id/expenses/:expenseId unfiles one, and it can be refiled', async () => {
      const before = (await call('GET', `/api/reports/${S.report.id}`, { token: S.E })).json.report.expenses.length;
      expectStatus(await call('DELETE', `/api/reports/${S.report.id}/expenses/${S.exp1.id}`, { token: S.E }), 200, 'unfile');
      const mid = (await call('GET', `/api/reports/${S.report.id}`, { token: S.E })).json.report.expenses.length;
      expect(mid === before - 1, `unfiling did not work: ${before} → ${mid}`);
      expectStatus(await call('POST', `/api/reports/${S.report.id}/expenses`, { token: S.E, body: { expenseIds: [S.exp1.id] } }), 200, 'refile');
    });
  }

  await check('GET /api/reports honours the scope', async () => {
    for (const [scope, token, who] of [['mine', S.E, 'Elaine'], ['team', S.H, 'Henry'], ['all', S.F, 'finance']]) {
      const r = await call('GET', `/api/reports?scope=${scope}`, { token });
      expectStatus(r, 200, `scope ${scope} as ${who}`);
    }
  });

  await check('a stranger cannot open the report', async () => {
    const other = await call('POST', '/api/users', { token: S.A, body: { email: 'nosy@solv.sg', password: 'password123', name: 'Nosy' } });
    S.N = (await call('POST', '/api/auth/login', { body: { email: 'nosy@solv.sg', password: 'password123' } })).json.token;
    expectStatus(await call('GET', `/api/reports/${S.report.id}`, { token: S.N }), [403, 404], 'stranger reading a report');
    S.nosyId = other.json.user.id;
  });

  await check('POST /api/reports/:id/review-all checks what it can and says why for the rest', async () => {
    const r = await call('POST', `/api/reports/${S.report.id}/review-all`, { token: S.E });
    expectStatus(r, 200, 'review-all');
    expect(typeof r.json.reviewed === 'number', 'no count of what was checked');
    expect(Array.isArray(r.json.skipped), 'no list of what could not be');
    return `${r.json.reviewed} checked, ${r.json.skipped.length} skipped`;
  });

  await check('a stranger cannot bulk-check someone else\'s case', async () => {
    expectStatus(await call('POST', `/api/reports/${S.report.id}/review-all`, { token: S.N }), [403, 404], 'stranger bulk-checking');
  });

  await check('POST /api/reports/:id/submit hands it over', async () => {
    const r = await call('POST', `/api/reports/${S.report.id}/submit`, { token: S.E });
    expectStatus(r, 200, 'submit');
    expect(r.json.report.status === 'submitted', `status is ${r.json.report.status}`);
  });

  await check('a submitted report locks its cover and its expenses', async () => {
    expectStatus(await call('PATCH', `/api/reports/${S.report.id}`, { token: S.E, body: { notes: 'sneaky edit' } }), 409, 'editing a submitted cover');
    if (S.exp1) expectStatus(await call('PATCH', `/api/expenses/${S.exp1.id}`, { token: S.E, body: { purpose: 'sneaky' } }), 409, 'editing a locked expense');
  });

  await check('the claimant cannot approve her own report', async () => {
    expectStatus(await call('POST', `/api/reports/${S.report.id}/approve`, { token: S.E }), 403, 'self-approval');
  });

  await check('GET /api/reports/queue shows it to the manager', async () => {
    const r = await call('GET', '/api/reports/queue', { token: S.H });
    expectStatus(r, 200, 'queue');
    expect((r.json.reports || []).some(x => x.id === S.report.id), 'the submitted report is not in the manager queue');
    return `${r.json.reports.length} waiting`;
  });

  await check('a rejection needs a reason, and reopens the report', async () => {
    expectStatus(await call('POST', `/api/reports/${S.report.id}/reject`, { token: S.H }), 400, 'reject with no reason');
    const r = await call('POST', `/api/reports/${S.report.id}/reject`, { token: S.H, body: { reason: 'Please attach the taxi receipt' } });
    expectStatus(r, 200, 'reject');
    expect(r.json.report.status === 'rejected', `status is ${r.json.report.status}`);
    expectStatus(await call('PATCH', `/api/reports/${S.report.id}`, { token: S.E, body: { notes: 'taxi receipt added' } }), 200, 'editing a rejected report');
  });

  await check('it can be resubmitted and approved by the manager', async () => {
    expectStatus(await call('POST', `/api/reports/${S.report.id}/submit`, { token: S.E }), 200, 'resubmit');
    const r = await call('POST', `/api/reports/${S.report.id}/approve`, { token: S.H });
    expectStatus(r, 200, 'approve');
    expect(r.json.report.status === 'approved', `status is ${r.json.report.status}`);
  });

  await check('only the claimant marks it claimed', async () => {
    expectStatus(await call('POST', `/api/reports/${S.report.id}/claimed`, { token: S.H }), 403, 'the manager who approved it');
    expectStatus(await call('POST', `/api/reports/${S.report.id}/claimed`, { token: S.F }), 403, 'finance');
    const r = await call('POST', `/api/reports/${S.report.id}/claimed`, { token: S.E });
    expectStatus(r, 200, 'the claimant');
    expect(r.json.report.status === 'claimed', `status is ${r.json.report.status}`);
    return `claimed ${r.json.report.claimedAt ? 'with a timestamp' : 'WITHOUT a timestamp'}`;
  });

  await check('a receipt can be claimed on its own and unclaimed again', async () => {
    const mine = await call('GET', '/api/expenses', { token: S.E });
    const one = (mine.json.expenses || []).find(e => !e.reportId) || (mine.json.expenses || [])[0];
    if (!one) return 'no expense to try it on';
    expectStatus(await call('POST', `/api/expenses/${one.id}/claimed`, { token: S.H }), [403, 404], 'somebody else claiming it');
    const on = await call('POST', `/api/expenses/${one.id}/claimed`, { token: S.E });
    expectStatus(on, 200, 'the owner claiming it');
    expect(on.json.expense.claimed === true, 'claimed is not true after claiming');
    const off = await call('DELETE', `/api/expenses/${one.id}/claimed`, { token: S.E });
    expectStatus(off, 200, 'the owner unclaiming it');
    expect(off.json.expense.claimed === false, 'claimed is not false after unclaiming');
    return 'on, then off';
  });

  await check('GET /api/reports/:id/events has the whole history', async () => {
    const r = await call('GET', `/api/reports/${S.report.id}/events`, { token: S.E });
    expectStatus(r, 200, 'events');
    const kinds = (r.json.events || []).map(e => e.kind || e.type || e.action);
    for (const want of ['created', 'submitted', 'rejected', 'approved', 'claimed']) {
      expect(kinds.includes(want), `the history is missing "${want}": ${kinds.join(', ')}`);
    }
    return kinds.join(' → ');
  });

  for (const [format, sniff] of [['pdf', b => b.slice(0, 4).toString() === '%PDF'], ['xlsx', b => b.slice(0, 2).toString() === 'PK'], ['csv', b => /Report,Line|,/.test(b.slice(0, 200).toString())]]) {
    await check(`the ${format.toUpperCase()} export downloads real bytes`, async () => {
      const u = await call('GET', `/api/reports/${S.report.id}/export-url?format=${format}`, { token: S.E });
      expectStatus(u, 200, `export-url ${format}`);
      const res = await fetch(base + u.json.url.replace(base, ''));
      expect(res.status === 200, `export ${format}: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.length > 200, `${format} export is only ${buf.length} bytes`);
      expect(sniff(buf), `${format} export does not look like a ${format}`);
      expect(/filename/.test(res.headers.get('content-disposition') || ''), 'no download filename');
      return `${(buf.length / 1024).toFixed(0)} kB`;
    });
  }

  await check('an export link with a bad token is refused', async () => {
    const r = await call('GET', `/api/reports/${S.report.id}/export?token=rubbish`, { raw: true });
    expect(r.status === 401 || r.status === 403, `bad export token: ${r.status}`);
  });

  await check('a stranger cannot mint an export link', async () => {
    expectStatus(await call('GET', `/api/reports/${S.report.id}/export-url?format=pdf`, { token: S.N }), [403, 404], 'stranger export-url');
  });

  await check('a draft report can be deleted, a claimed one cannot', async () => {
    expectStatus(await call('DELETE', `/api/reports/${S.report.id}`, { token: S.E }), [400, 403, 409], 'deleting a claimed report');
    const d = await call('POST', '/api/reports', { token: S.E, body: { title: 'Throwaway' } });
    expectStatus(await call('DELETE', `/api/reports/${d.json.report.id}`, { token: S.E }), 200, 'deleting a draft');
  });

  // ── 8b. Cases ───────────────────────────────────────────────────────────
  section('Cases');

  // Unique bytes each time, so the duplicate guard does not answer instead of
  // the case guard. The reader will make nothing of them, which is fine: what
  // is being checked is where the receipt lands, not what it says.
  let _b = 0;
  const scrap = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, ++_b, Date.now() % 251]).toString('base64');
  const countMine = async () => ((await call('GET', '/api/expenses', { token: S.E })).json.expenses || []).length;
  // The reader runs after the upload answers, and an expense still being read
  // cannot be edited or checked. Every case check below waits for it.
  const waitRead = async id => {
    for (let i = 0; i < 40; i++) {
      const e = (await call('GET', `/api/expenses/${id}`, { token: S.E })).json.expense;
      if (!e || e.status !== 'reading') return e;
      await sleep(1500);
    }
    throw new Error('the read never finished');
  };

  await check('a case can be created by hand', async () => {
    const r = await call('POST', '/api/reports', { token: S.E, body: { kind: 'case', title: 'Chakan commissioning', purpose: 'Site work' } });
    expectStatus(r, [200, 201], 'create case');
    expect(r.json.report.kind === 'case', `kind came back as ${r.json.report.kind}`);
    S.case = r.json.report;
    return r.json.report.number;
  });

  await check('a receipt uploaded into a case is in it straight away, unchecked', async () => {
    const r = await call('POST', '/api/receipts', { token: S.E, body: { mime: 'image/jpeg', data: scrap(), filename: 'a.jpg', reportId: S.case.id } });
    expectStatus(r, 201, 'upload into a case');
    S.caseExpense = r.json.expense.id;
    const e = await waitRead(S.caseExpense);
    expect(e.reportId === S.case.id, `the receipt did not join the case: ${e.reportId}`);
    expect(e.status !== 'reviewed', 'it should not be checked yet');
    return 'in the case, waiting to be checked';
  });

  await check('a refused upload leaves nothing behind', async () => {
    const before = await countMine();
    const theirs = (await call('POST', '/api/reports', { token: S.H, body: { kind: 'case', title: "Henry's case" } })).json.report;
    const r = await call('POST', '/api/receipts', { token: S.E, body: { mime: 'image/jpeg', data: scrap(), filename: 'b.jpg', reportId: theirs.id } });
    expectStatus(r, [403, 404], 'uploading into someone else\'s case');
    const after = await countMine();
    expect(after === before, `the refused upload still created ${after - before} expense(s)`);
  });

  await check('a case that has been submitted takes no more receipts', async () => {
    const c = (await call('POST', '/api/reports', { token: S.E, body: { kind: 'case', title: 'Closed case' } })).json.report;
    const up = await call('POST', '/api/receipts', { token: S.E, body: { mime: 'image/jpeg', data: scrap(), filename: 'c.jpg', reportId: c.id } });
    expectStatus(up, 201, 'seed the case');
    await waitRead(up.json.expense.id);
    expectStatus(await call('PATCH', `/api/expenses/${up.json.expense.id}`, { token: S.E, body: { merchant: 'Kopitiam', receiptDate: '2026-09-10', currency: 'SGD', total: 12.5 } }), 200, 'fill the receipt in');
    expectStatus(await call('PUT', `/api/expenses/${up.json.expense.id}/lines`, { token: S.E, body: { lines: [{ category: 'Meals', amount: 12.5, currency: 'SGD' }] } }), 200, 'give it a line');
    await call('PATCH', `/api/expenses/${up.json.expense.id}/status`, { token: S.E, body: { status: 'reviewed' } });
    expectStatus(await call('POST', `/api/reports/${c.id}/submit`, { token: S.E }), 200, 'submit the case');
    const before = await countMine();
    expectStatus(await call('POST', '/api/receipts', { token: S.E, body: { mime: 'image/jpeg', data: scrap(), filename: 'd.jpg', reportId: c.id } }), 409, 'uploading into a submitted case');
    expect(await countMine() === before, 'the refused upload still created an expense');
    S.submittedCase = c.id;
  });

  await check('a phone session opened for a case sends its photographs there', async () => {
    const pair = await call('POST', '/api/receipts/pair', { token: S.E, body: { reportId: S.case.id } });
    expectStatus(pair, [200, 201], 'pair for a case');
    const page = await call('GET', `/api/receipts/capture/${pair.json.token}`, { tag: 'GET /api/receipts/capture/:id' });
    expectStatus(page, 200, 'the phone page');
    expect(page.json.reportId === S.case.id, 'the phone was not told which case it is filling');
    expect(page.json.case && page.json.case.number === S.case.number, 'the phone does not show the case name');
    const up = await call('POST', `/api/receipts/capture/${pair.json.token}`, { tag: 'POST /api/receipts/capture/:id', body: { mime: 'image/jpeg', data: scrap(), filename: 'phone.jpg' } });
    expectStatus(up, 201, 'phone upload');
    const e = await waitRead(up.json.expense.id);
    expect(e.reportId === S.case.id, 'the photograph did not land in the case');
    return `${page.json.case.number} · ${page.json.case.title}`;
  });

  await check('a whole case is checked in one call, and says what it could not', async () => {
    const inCase = (await call('GET', `/api/reports/${S.case.id}`, { token: S.E })).json.report.expenses;
    for (const e of inCase) {
      await waitRead(e.id);
      await call('PATCH', `/api/expenses/${e.id}`, { token: S.E, body: { merchant: 'Kopitiam', receiptDate: '2026-09-11', currency: 'SGD', total: 8.4 } });
      await call('PUT', `/api/expenses/${e.id}/lines`, { token: S.E, body: { lines: [{ category: 'Meals', amount: 8.4, currency: 'SGD' }] } });
    }
    const r = await call('POST', `/api/reports/${S.case.id}/review-all`, { token: S.E });
    expectStatus(r, 200, 'review-all');
    expect(r.json.reviewed >= 1, `nothing was checked: ${JSON.stringify(r.json.skipped).slice(0, 120)}`);
    expect(Array.isArray(r.json.skipped), 'no list of what could not be checked');
    return `${r.json.reviewed} checked, ${r.json.skipped.length} could not be`;
  });

  await check('a submitted case cannot be bulk-checked, and a stranger never can', async () => {
    expectStatus(await call('POST', `/api/reports/${S.submittedCase}/review-all`, { token: S.E }), 409, 'bulk-checking a submitted case');
    expectStatus(await call('POST', `/api/reports/${S.case.id}/review-all`, { token: S.N }), [403, 404], 'a stranger bulk-checking');
  });

  // ── 9. Xero ─────────────────────────────────────────────────────────────
  section('Xero');

  await check('GET /api/xero reports the connection state', async () => {
    const r = await call('GET', '/api/xero', { token: S.F });
    expectStatus(r, 200, 'xero status');
    expect(r.json.connected === false || r.json.connected === undefined, 'it should not claim to be connected');
    return `connected: ${!!r.json.connected}`;
  });

  await check('an employee cannot touch the Xero settings', async () => {
    expectStatus(await call('PATCH', '/api/xero/credentials', { token: S.E, body: { XERO_CLIENT_ID: 'x' } }), 403, 'employee patching credentials');
    expectStatus(await call('POST', '/api/xero/test', { token: S.E }), 403, 'employee testing Xero');
  });

  await check('PATCH /api/xero/credentials stores keys and masks the secret', async () => {
    const r = await call('PATCH', '/api/xero/credentials', { token: S.F, body: { XERO_CLIENT_ID: 'audit-client', XERO_CLIENT_SECRET: 'audit-secret-value', DEFAULT_ACCOUNT_CODE: '429' } });
    expectStatus(r, 200, 'patch credentials');
    const read = await call('GET', '/api/xero', { token: S.F });
    expect(!JSON.stringify(read.json).includes('audit-secret-value'), 'the Xero client secret came back to the client');
    return 'secret not echoed';
  });

  await check('a connection test against bad keys fails with a sentence, not a stack', async () => {
    const r = await call('POST', '/api/xero/test', { token: S.F });
    expect(r.status >= 400 && r.status < 600, `test returned ${r.status}`);
    expect(typeof r.json.error === 'string' && !/at \w+ \(/.test(r.json.error), `a stack trace reached the client: ${String(r.json.error).slice(0, 80)}`);
    return `${r.status}: ${String(r.json.error).slice(0, 44)}`;
  });

  await check('GET /api/xero/tenants answers when nothing is connected', async () => {
    expectStatus(await call('GET', '/api/xero/tenants', { token: S.F }), [200, 400, 404], 'tenants');
  });

  await check('GET /api/xero/accounts fails gracefully when nothing is connected', async () => {
    const r = await call('GET', '/api/xero/accounts', { token: S.F });
    expect(r.status !== 500 || typeof r.json.error === 'string', 'accounts threw a bare 500');
    return `${r.status}`;
  });

  await check('the OAuth start returns a URL or a clear refusal', async () => {
    const r = await call('GET', '/api/xero/oauth/connect', { token: S.F, raw: true });
    expect([200, 302, 400, 409].includes(r.status), `oauth connect returned ${r.status}`);
    return `${r.status}`;
  });

  await check('an OAuth callback carrying an error does not crash', async () => {
    const r = await call('GET', '/api/xero/oauth/callback?error=access_denied&state=nonsense', { raw: true });
    expect(r.status < 500, `callback with an error returned ${r.status}`);
    return `${r.status}`;
  });

  await check('completing OAuth with a bad state is refused', async () => {
    const r = await call('POST', '/api/xero/oauth/complete', { token: S.F, body: { code: 'x', state: 'never-issued' } });
    expect(r.status >= 400 && r.status < 500, `bad state returned ${r.status}`);
  });

  await check('DELETE /api/xero/oauth/disconnect is safe when not connected', async () => {
    expectStatus(await call('DELETE', '/api/xero/oauth/disconnect', { token: S.F }), [200, 204, 400, 404], 'disconnect');
  });

  await check('POST /api/reports/:id/post?dryRun=1 shows the bill without sending it', async () => {
    const r = await call('POST', `/api/reports/${S.report.id}/post?dryRun=1`, { token: S.F });
    expectStatus(r, 200, 'dry run');
    const bill = r.json.bill || r.json.invoice || r.json.dryRun || r.json;
    const s = JSON.stringify(bill);
    expect(/ACCPAY/.test(s), 'the dry run did not produce an ACCPAY bill');
    expect(/DRAFT/.test(s), 'the bill is not a draft');
    return 'ACCPAY draft built';
  });

  await check('an employee cannot post to Xero', async () => {
    expectStatus(await call('POST', `/api/reports/${S.report.id}/post?dryRun=1`, { token: S.E }), 403, 'employee posting');
  });

  // ── 10. claim import ────────────────────────────────────────────────────
  section('Batch claim import');

  await check('GET /api/claims/active answers', async () => {
    expectStatus(await call('GET', '/api/claims/active', { token: S.E }), 200, 'active claims');
  });

  await check('an import with nothing in it is refused', async () => {
    expectStatus(await call('POST', '/api/claims/import', { token: S.E, body: {} }), 400, 'empty import');
  });

  if (!NO_MODEL) {
    await check('POST /api/claims/import queues a job and the worker runs it', async () => {
      const r = await call('POST', '/api/claims/import', { token: S.E, body: { forms: [{ mime: 'application/pdf', data: pune.toString('base64'), filename: 'claim form.pdf' }], label: 'audit' } });
      expectStatus(r, [200, 201, 202], 'queue import');
      S.jobId = r.json.jobId || r.json.job && r.json.job.id;
      expect(S.jobId, `no job id came back: ${JSON.stringify(r.json).slice(0, 120)}`);
      let job;
      for (let i = 0; i < 40; i++) {
        const j = await call('GET', `/api/claims/import/${S.jobId}`, { token: S.E });
        job = j.json.job || j.json;
        const stage = String(job && (job.stage || job.status));
        if (['done', 'failed', 'error', 'cancelled'].includes(stage)) break;
        await sleep(3000);
      }
      expect(job, 'the job never came back');
      const stage = String(job.stage || job.status);
      expect(stage !== 'undefined', `the job carries no stage: ${JSON.stringify(job).slice(0, 120)}`);
      expect(stage !== 'queued', `the worker never picked the job up (stage ${stage})`);
      S.importJob = job;
      return `finished as "${stage}"`;
    });

    await check('what the import created is in a case of its own', async () => {
      const job = S.importJob;
      if (!job || job.stage !== 'done') return `the import finished as ${job && job.stage}, nothing to check`;
      const caseId = job.result && job.result.caseId;
      const made = (job.result && job.result.created) || [];
      if (!made.length) return 'the import created nothing, so no case was expected';
      expect(caseId, 'the import created records but no case');
      const c = await call('GET', `/api/reports/${caseId}`, { token: S.E });
      expectStatus(c, 200, 'read the case the import made');
      expect(c.json.report.kind === 'case', `the import made a ${c.json.report.kind}, not a case`);
      expect(c.json.report.expenses.length > 0, 'the case the import made is empty');
      expect(/claim form|\w/.test(c.json.report.title || ''), 'the case has no title');
      return `${c.json.report.number} · ${c.json.report.expenses.length} in it`;
    });

    await check('DELETE /api/claims/import/:jobId clears the job', async () => {
      expectStatus(await call('DELETE', `/api/claims/import/${S.jobId}`, { token: S.E }), [200, 204, 404], 'delete job');
    });
  }

  await check('DELETE /api/claims/group/:groupId is safe for an unknown group', async () => {
    expectStatus(await call('DELETE', '/api/claims/group/no-such-group', { token: S.E, tag: 'DELETE /api/claims/group/:id' }), [200, 204, 404], 'delete unknown group');
  });

  // ── 10b. the dashboard's figures ────────────────────────────────────────
  section('Dashboard summary');
  await check('GET /api/dashboard/summary answers, scoped to who is asking', async () => {
    const mine = await call('GET', '/api/dashboard/summary', { token: S.E });
    expectStatus(mine, 200, 'employee');
    expect(mine.json.scope === 'own', `an employee's scope is "${mine.json.scope}", not "own"`);
    const boss = await call('GET', '/api/dashboard/summary', { token: S.A });
    expectStatus(boss, 200, 'admin');
    expect(boss.json.scope === 'company', `an admin's scope is "${boss.json.scope}", not "company"`);
    expect(Array.isArray(boss.json.months) && boss.json.months.length === 6, 'six months of figures were not returned');
    expect(boss.json.total >= mine.json.total, 'the company total is smaller than one employee\'s');
    return `own ${mine.json.base} ${mine.json.total} · company ${boss.json.total}`;
  });

  await check('the summary needs a token', async () => {
    expectStatus(await call('GET', '/api/dashboard/summary', {}), 401, 'no token');
  });

  // ── 11. sign out ────────────────────────────────────────────────────────
  section('Sign out');
  await check('POST /api/auth/logout answers', async () => {
    expectStatus(await call('POST', '/api/auth/logout', { token: S.E }), 200, 'logout');
  });

  // ── report ──────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  const errorLines = log.split('\n').filter(l => /"level":"error"/.test(l));

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    console.log('\nFAILURES');
    for (const f of failed) console.log(`  [${f.group}] ${f.name}\n      ${f.err}`);
  }

  // which routes never got exercised
  const declared = [];
  for (const file of fs.readdirSync(path.join(ROOT, 'main/routes')).filter(f => f.endsWith('.js') && !f.includes('.test.'))) {
    const mount = file.replace('.js', '');
    const src = fs.readFileSync(path.join(ROOT, 'main/routes', file), 'utf8');
    for (const m of src.matchAll(/router\.(get|post|patch|put|delete)\(\s*'([^']*)'/g)) {
      const p = m[2] === '/' ? '' : m[2];
      declared.push(`${m[1].toUpperCase()} /api/${mount}${p}`.replace(/:\w+/g, s => (s === ':jobId' || s === ':groupId' || s === ':expenseId' ? s : s)));
    }
  }
  // every path parameter is the same thing for coverage purposes
  const norm = r => r.replace(/:\w+/g, ':id');
  const hitNorm = new Set([...HIT].map(norm));
  const missed = declared.filter(d => !hitNorm.has(norm(d)));
  console.log(`\nroutes exercised: ${declared.length - missed.length}/${declared.length}`);
  if (missed.length) for (const m of missed) console.log(`  not reached: ${m}`);

  console.log(`\nserver error lines: ${errorLines.length}`);
  for (const l of errorLines.slice(0, 10)) console.log(`  ${l.slice(0, 200)}`);

  server.kill();
  process.exit(failed.length || errorLines.length ? 1 : 0);
})().catch(err => {
  console.error('\nThe audit itself broke:', err);
  console.error(log.split('\n').slice(-25).join('\n'));
  server.kill();
  process.exit(2);
});
