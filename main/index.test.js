// The server as it starts in production: index.js itself, in its own process.
// No other test loads it, so its middleware — body limits, the error handler,
// the query check, the /api 404 and the CSP — was untested, and a mistake in
// any of them would be found by the first visitor.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

let child, base;

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', JWT_SECRET: 'x'.repeat(48) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  // Ready when it answers; the logger is silent under test, so there is no line to wait for.
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/dashboard/health`)).ok) return; } catch { /* not listening yet */ }
    if (child.exitCode !== null) throw new Error(`index.js exited: ${stderr.slice(0, 800)}`);
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`index.js did not start: ${stderr.slice(0, 800)}`);
}, 30000);

afterAll(() => { if (child && child.exitCode === null) child.kill(); });

test('health answers, with the security headers on', async () => {
  const res = await fetch(`${base}/dashboard/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: expect.stringMatching(/healthy/) });
  const csp = res.headers.get('content-security-policy');
  expect(csp).toMatch(/img-src 'self' data: blob:/);       // receipt previews are blob: and data: URLs
  expect(csp).toMatch(/object-src 'none'/);
});

test('an unknown API path is a JSON 404, not the UI', async () => {
  const res = await fetch(`${base}/api/no-such-thing`);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: 'Not found' });
});

test('a repeated query parameter is a 400, not a database error', async () => {
  for (const q of ['from=a&from=b', 'reportId[x]=1']) {
    const res = await fetch(`${base}/api/expenses?${q}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/once/);
  }
});

test('a body over 100 KB, and one that is not JSON, are named as such', async () => {
  let res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a'.repeat(200 * 1024) }) });
  expect(res.status).toBe(413);
  expect((await res.json()).error).toBe('That request is too large.');
  res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('That request is not valid JSON.');
});

test('SIGTERM shuts it down cleanly', async () => {
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  child.kill('SIGTERM');
  // Windows has no SIGTERM to catch: the process is simply ended.
  const code = await exited;
  if (process.platform !== 'win32') expect(code).toBe(0);
}, 15000);
