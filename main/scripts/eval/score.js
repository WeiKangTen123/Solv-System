// Scores a run of the reader (run.js) against the truth in receipts.js:
// every receipt field by field, then each field across the receipts, then
// the whole. Two runs side by side when given two tags.
//
// A field is correct, wrong, missing (nothing read where something is
// printed), or judgement (one of several defensible answers, counted as
// right). Some fields are about more than one value: `lines` the report
// lines by category and person, `checks` whether exactly the expected
// read-time checks fired, and the receipt as printed, row by row: `items`
// how many items it prints, each tax's name (`taxLabels`), rate
// (`taxRates`) and amount with whether it is inside the prices
// (`taxAmounts`), the `charges`, and the `rounding`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SYNTH, SAMPLES } = require('./receipts');

const TRUTH = Object.fromEntries([...Object.entries(SYNTH), ...Object.entries(SAMPLES)].map(([k, v]) => [k, v.truth]));
const VALUE_FIELDS = ['merchant', 'date', 'time', 'invoiceNumber', 'currency', 'total', 'tax', 'subTotal', 'category', 'city', 'country', 'docType'];
const ROW_FIELDS = ['taxLabels', 'taxRates', 'taxAmounts', 'charges', 'rounding'];
// The seventeen fields scored before the receipt was kept as printed, for a
// figure that compares with the 98.8% of 87c562d (`items` then counted the
// lines kept, now the items printed; `subTotal` is now as printed).
const BEFORE = [...VALUE_FIELDS, 'description', 'items', 'lines', 'refund', 'checks'];
const FIELDS = [...BEFORE, ...ROW_FIELDS];
// The fields the investigation of 2026-10-28 scored, for a figure that
// compares with its 92%.
const CORE = [...VALUE_FIELDS, 'description', 'items', 'lines'];

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
  scoreRows(t.rows, o.printed ? o.printed.rows : (r.rows || null), note, res);
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

// The receipt as printed against what it prints. A receipt with no rows to
// score (a refund) has none of these fields.
const near = (a, b, tol = 0.005) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(Number(a) - Number(b)) < tol;
function scoreRows(want, rows, note, res) {
  if (!want) { for (const k of ['items', ...ROW_FIELDS]) res[k] = 'n/a'; return; }
  if (!Array.isArray(rows)) { for (const k of ['items', ...ROW_FIELDS]) note(k, 'missing', 'no rows read'); return; }
  const of = kind => rows.filter(x => x.kind === kind);
  const items = of('item').length;
  note('items', items === want.items ? 'correct' : 'wrong', `${items} items, expected ${want.items}`);
  const taxes = of('tax');
  const said = taxes.map(x => `${x.label} ${x.rate ?? '-'}% ${x.amount}${x.included ? ' incl.' : ''}`).join(', ') || 'none';
  if (Array.isArray(want.taxes)) {
    const same = test => taxes.length === want.taxes.length && want.taxes.every((w, i) => test(w, taxes[i]));
    note('taxLabels', same((w, g) => w.label.test(String(g.label))) ? 'correct' : 'wrong', `read ${said}`);
    note('taxRates', same((w, g) => near(w.rate, g.rate, 0.0005)) ? 'correct' : 'wrong', `read ${said}`);
    note('taxAmounts', same((w, g) => near(w.amount, g.amount) && !!w.included === !!g.included) ? 'correct' : 'wrong', `read ${said}`);
  } else {
    const w = want.taxes, count = taxes.length === w.count;
    const sum = taxes.reduce((n, x) => n + Number(x.amount), 0);
    note('taxLabels', count && taxes.every(x => w.label.test(String(x.label))) ? 'correct' : 'wrong', `${taxes.length} taxes, expected ${w.count}`);
    note('taxRates', count && taxes.every(x => near(x.rate, w.rate, 0.0005)) ? 'correct' : 'wrong', `rates ${[...new Set(taxes.map(x => x.rate))].join(', ')}`);
    note('taxAmounts', count && near(sum, w.sum, 1.0001) ? 'correct' : 'wrong', `${taxes.length} taxes come to ${Math.round(sum * 100) / 100}, expected ${w.sum}`);
  }
  const charges = of('charge').map(x => Number(x.amount));
  note('charges', charges.length === want.charges.length && want.charges.every((w, i) => near(w, charges[i])) ? 'correct' : 'wrong',
       `read [${charges.join(', ')}], expected [${want.charges.join(', ')}]`);
  const rounding = of('rounding').reduce((n, x) => (n === null ? 0 : n) + Number(x.amount), null);
  note('rounding', want.rounding === null ? (rounding === null ? 'correct' : 'wrong') : (near(rounding, want.rounding) ? 'correct' : (rounding === null ? 'missing' : 'wrong')),
       `read ${rounding}, expected ${want.rounding}`);
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
  const tallies = runs.map(({ rows }) => ({ all: tally(rows, FIELDS), before: tally(rows, BEFORE), core: tally(rows, CORE) }));
  for (const f of FIELDS) {
    log(`${f.padEnd(14)} ${tallies.map(t => `${String(t.all.per[f].right).padStart(2)}/${String(t.all.per[f].of).padEnd(2)} ${pct(t.all.per[f].right, t.all.per[f].of).padStart(6)}`).join('   ')}`);
  }
  log(`${'all fields'.padEnd(14)} ${tallies.map(t => `${t.all.right}/${t.all.all} ${pct(t.all.right, t.all.all)}`).join('   ')}`);
  log(`${'as before'.padEnd(14)} ${tallies.map(t => `${t.before.right}/${t.before.all} ${pct(t.before.right, t.before.all)}`).join('   ')}  (the seventeen fields scored before the rows)`);
  log(`${'core fields'.padEnd(14)} ${tallies.map(t => `${t.core.right}/${t.core.all} ${pct(t.core.right, t.core.all)}`).join('   ')}  (without refund, checks and the rows)`);
  return runs.map((r, i) => ({ tag: r.tag, rows: r.rows, ...tallies[i] }));
}

module.exports = { report, scoreRun, scoreOne, scoreRows, checkNames, FIELDS, BEFORE, CORE, ROW_FIELDS };
