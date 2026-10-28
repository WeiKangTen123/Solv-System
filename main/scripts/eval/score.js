// Scores a run of the reader (run.js) against the truth in receipts.js:
// every receipt field by field, then each field across the receipts, then
// the whole. Two runs side by side when given two tags.
//
// A field is correct, wrong, missing (nothing read where something is
// printed), or judgement (one of several defensible answers, counted as
// right). Three fields are about more than one value: `items` is how many
// charge lines the read kept, `lines` the report lines by category and
// person, and `checks` whether exactly the expected read-time checks fired.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SYNTH, SAMPLES } = require('./receipts');

const TRUTH = Object.fromEntries([...Object.entries(SYNTH), ...Object.entries(SAMPLES)].map(([k, v]) => [k, v.truth]));
const VALUE_FIELDS = ['merchant', 'date', 'time', 'invoiceNumber', 'currency', 'total', 'tax', 'subTotal', 'category', 'city', 'country', 'docType'];
const FIELDS = [...VALUE_FIELDS, 'description', 'items', 'lines', 'refund', 'checks'];
// The fields the investigation of 2026-10-28 scored, for a figure that
// compares with its 92%.
const CORE = FIELDS.filter(f => f !== 'refund' && f !== 'checks');

// The real folios' invoice numbers are kept only as a hash.
const invoiceHash = s => crypto.createHash('sha256').update(String(s).replace(/\s+/g, '').toUpperCase()).digest('hex').slice(0, 16);

function match(exp, got) {
  if (exp && exp.judgement) return exp.judgement.includes(got) ? 'judgement' : 'wrong';
  if (Array.isArray(exp)) return exp.some(e => match(e, got) === 'correct') ? 'correct' : (got == null ? 'missing' : 'wrong');
  if (exp instanceof RegExp) return got == null ? 'missing' : (exp.test(String(got)) ? 'correct' : 'wrong');
  if (exp === null) return got == null ? 'correct' : 'wrong';
  if (typeof exp === 'number') return got == null ? 'missing' : (Math.abs(Number(got) - exp) < 0.005 ? 'correct' : 'wrong');
  return got == null ? 'missing' : (String(got).trim() === exp ? 'correct' : 'wrong');
}
const shown = v => (v instanceof RegExp ? String(v) : JSON.stringify(v));

// The checks a read raised, by name, from aiRead.checks' shape.
function checkNames(c) {
  if (!c) return [];
  const out = [];
  if (c.subtotalMismatch) out.push('subtotalMismatch');
  if (Array.isArray(c.chargedTwice) && c.chargedTwice.length) out.push('chargedTwice');
  if (Array.isArray(c.people) && c.people.length) out.push('people');
  if (c.adjusted) out.push('adjusted');
  if (c.dateOrder) out.push('dateOrder');
  return out.sort();
}

function scoreOne(t, o) {
  const r = o.result || {};
  const res = {}, notes = [];
  const note = (k, s, text) => { res[k] = s; if (s === 'wrong' || s === 'missing') notes.push(`${k}: ${text}`); };
  for (const k of VALUE_FIELDS) {
    if (k === 'invoiceNumber' && t.invoiceHash) {
      const s = r.invoiceNumber == null ? 'missing' : (invoiceHash(r.invoiceNumber) === t.invoiceHash ? 'correct' : 'wrong');
      note(k, s, `read ${JSON.stringify(r.invoiceNumber)}, not the number printed`);
      continue;
    }
    note(k, match(t[k], r[k]), `read ${JSON.stringify(r[k])}, expected ${shown(t[k])}`);
  }
  // What was bought and where, and never why.
  const d = r.description || '';
  const descOk = d.startsWith(`[${r.category}]`) && d.includes('@') && !/client|meeting|discuss|business|project/i.test(d) && (t.descMust || []).every(re => re.test(d));
  note('description', descOk ? 'correct' : 'wrong', JSON.stringify(d));
  if (t.items === null || t.items === undefined) res.items = 'n/a';
  else {
    const n = (r.lineItems || []).length;
    note('items', n === t.items ? 'correct' : 'wrong', `${n} kept, expected ${t.items}`);
  }
  const got = {};
  for (const l of o.lines || []) { const key = `${l.category}|${l.onBehalfOf ? 'OB' : ''}`; got[key] = Math.round(((got[key] || 0) + l.amount) * 100) / 100; }
  const tol = t.lineTol ?? 0.01;
  let linesOk = Object.entries(t.lines).every(([k, v]) => Math.abs((got[k] || 0) - v) <= tol + 1e-9);
  if (!t.partialLines && Object.keys(got).some(k => !(k in t.lines))) linesOk = false;
  note('lines', linesOk ? 'correct' : 'wrong', `got ${JSON.stringify(got)}, expected ${JSON.stringify(t.lines)}`);
  const refund = !!r.refund;
  note('refund', refund === !!t.refund ? 'correct' : 'wrong', refund ? 'read as a refund' : 'not read as a refund');
  const fired = checkNames(o.checks);
  const want = [...(t.checks || [])].sort();
  note('checks', JSON.stringify(fired) === JSON.stringify(want) ? 'correct' : 'wrong', `fired ${JSON.stringify(fired)}, expected ${JSON.stringify(want)}`);
  return { res, notes };
}

// Every saved read of one run, scored.
function scoreRun(out, tag) {
  const dir = path.join(out, tag);
  if (!fs.existsSync(dir)) throw new Error(`No run "${tag}" in ${out}`);
  const rows = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort()) {
    const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const t = TRUTH[o.name];
    if (!t) continue;
    rows.push({ name: o.name, seconds: o.seconds, calls: (o.modelCalls || []).length, ...scoreOne(t, o) });
  }
  return rows;
}

const ok = s => s === 'correct' || s === 'judgement';
function tally(rows, fields) {
  const per = {};
  let right = 0, all = 0;
  for (const f of fields) {
    const marks = rows.map(r => r.res[f]).filter(s => s && s !== 'n/a');
    per[f] = { right: marks.filter(ok).length, of: marks.length };
    right += per[f].right; all += per[f].of;
  }
  return { per, right, all };
}
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');

function report(out, tags, log = console.log) {
  const runs = tags.map(tag => ({ tag, rows: scoreRun(out, tag) }));
  for (const { tag, rows } of runs) {
    log(`\n=== ${tag}: per receipt`);
    for (const row of rows) {
      const marks = Object.values(row.res).filter(s => s !== 'n/a');
      log(`${row.name.padEnd(26)} ${String(marks.filter(ok).length).padStart(2)}/${marks.length}  (${row.seconds}s, ${row.calls} call${row.calls === 1 ? '' : 's'})`);
      for (const n of row.notes) log(`    - ${n}`);
    }
  }
  log(`\n=== per field${tags.length > 1 ? ` (${tags.join(' → ')})` : ''}`);
  const tallies = runs.map(({ rows }) => ({ all: tally(rows, FIELDS), core: tally(rows, CORE) }));
  for (const f of FIELDS) {
    log(`${f.padEnd(14)} ${tallies.map(t => `${String(t.all.per[f].right).padStart(2)}/${String(t.all.per[f].of).padEnd(2)} ${pct(t.all.per[f].right, t.all.per[f].of).padStart(6)}`).join('   ')}`);
  }
  log(`${'all fields'.padEnd(14)} ${tallies.map(t => `${t.all.right}/${t.all.all} ${pct(t.all.right, t.all.all)}`).join('   ')}`);
  log(`${'core fields'.padEnd(14)} ${tallies.map(t => `${t.core.right}/${t.core.all} ${pct(t.core.right, t.core.all)}`).join('   ')}  (without refund and checks)`);
  return runs.map((r, i) => ({ tag: r.tag, rows: r.rows, ...tallies[i] }));
}

module.exports = { report, scoreRun, scoreOne, checkNames, FIELDS, CORE };
