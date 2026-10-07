// Every setting the server reads is documented in .env.example. Seven were
// not, so a box could only be configured by reading the source.
const fs = require('fs');
const path = require('path');

// Read by the platform or only to warn that they are no longer used.
const NOT_SETTINGS = new Set(['NODE_ENV', 'PATH', 'HOSTNAME', 'ALLOW_REGISTRATION']);

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (!['node_modules', 'data', 'scripts', 'test-fixtures'].includes(f.name)) walk(p, out); }
    else if (/\.(js|mjs)$/.test(f.name) && !f.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

test('.env.example names every environment variable the server reads', () => {
  const read = new Set();
  for (const f of walk(__dirname)) for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) read.add(m[1]);
  const example = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
  const missing = [...read].filter(v => !NOT_SETTINGS.has(v) && !new RegExp(`^#? *${v}=`, 'm').test(example));
  expect(missing).toEqual([]);
});
