// Reads every eval receipt through the real reader, as a re-read reads one
// (readOne, then the record of the receipt as printed and the claim lines
// made from it, then the read-time checks), and keeps for each what came
// back: the model's raw replies, the normalised read, the record, the report
// lines and the checks. A version of the code from before the record makes
// its lines with buildLines, as it did then, so two runs can be compared.
//
// It calls the live model, so it is never part of the test suite, and it
// counts every request so a run can be held to a budget. Nothing is written
// inside the repository: the reader's logs and the database it opens go to
// the output folder too.
const fs = require('fs');
const path = require('path');
const { SYNTH, SAMPLES } = require('./receipts');

// Only the model key is taken from the env file. The rest of a server's
// settings (NODE_ENV, a database path) must not steer a script.
function _loadKey(envFile) {
  if (!fs.existsSync(envFile)) throw new Error(`No env file at ${envFile}`);
  const parsed = require('dotenv').parse(fs.readFileSync(envFile));
  const key = parsed.Gemini_API_KEY || parsed.GEMINI_API_KEY;
  if (!key) throw new Error(`No Gemini_API_KEY in ${envFile}`);
  process.env.Gemini_API_KEY = key;
}

// Every request the reader makes, timed, with the reply it got. The key is
// in a header, never in what is kept.
function _countCalls() {
  const axios = require('axios');
  const calls = [];
  const post = axios.post.bind(axios);
  axios.post = async (url, body, cfg) => {
    const rec = { model: body && body.model, startedAt: new Date().toISOString() };
    const t0 = Date.now();
    calls.push(rec);
    try {
      const res = await post(url, body, cfg);
      Object.assign(rec, { ms: Date.now() - t0, status: res.status, finish: res.data?.choices?.[0]?.finish_reason,
        usage: res.data?.usage, content: res.data?.choices?.[0]?.message?.content });
      return res;
    } catch (err) {
      Object.assign(rec, { ms: Date.now() - t0, status: err.response && err.response.status, error: err.message });
      throw err;
    }
  };
  return calls;
}

function _items({ only, samplesDir, synthDir }) {
  const list = [];
  for (const name of Object.keys(SYNTH)) list.push({ name, file: path.join(synthDir, `${name}.jpg`), mime: 'image/jpeg' });
  for (const [name, s] of Object.entries(SAMPLES)) list.push({ name, file: path.join(samplesDir, s.file), mime: 'application/pdf' });
  return list.filter(x => !only || only.includes(x.name));
}

// Reads each receipt into <out>/<tag>/<name>.json. Stops before a receipt
// once maxCalls requests have been made, and says which were left unread.
async function run({ env, out, tag, only = null, samplesDir, maxCalls = 30, log = console.log }) {
  fs.mkdirSync(path.join(out, tag), { recursive: true });
  process.env.LOGS_DIR = path.join(out, 'logs');
  process.env.DB_PATH = path.join(out, 'eval.db');
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
  _loadKey(env);
  const calls = _countCalls();
  const reader = require('../../receipts/read-receipt');
  const { canonicalCategory } = require('../../intake/categories');
  let claimLines = null;
  try { ({ claimLines } = require('../../receipts/printed')); } catch { /* a version from before the record */ }

  const items = _items({ only, samplesDir, synthDir: path.join(out, 'synth') });
  const skipped = [];
  for (const it of items) {
    if (!fs.existsSync(it.file)) { skipped.push(`${it.name} (no file at ${it.file})`); continue; }
    if (calls.length >= maxCalls) { skipped.push(`${it.name} (budget of ${maxCalls} calls spent)`); continue; }
    const before = calls.length;
    const t0 = Date.now();
    let r = null, error = null;
    try { r = await reader.readOne(null, fs.readFileSync(it.file), it.mime); } catch (err) { error = err.message; }
    const mine = calls.slice(before);
    // The record and its lines as applyRead makes them, from the receipt's
    // own category.
    const printed = r && typeof reader.recordOf === 'function' ? reader.recordOf(r) : null;
    const category = r ? (canonicalCategory(r.category) || 'Other') : 'Other';
    const lines = !r ? [] : printed && claimLines ? claimLines(printed, category, { description: r.description || r.merchant }) : reader.buildLines(r, 'Other');
    // The checks arrived with this harness's first use; a reader from before
    // them has none to give.
    const checks = r && typeof reader.readChecks === 'function' ? reader.readChecks(r, lines) : null;
    const record = {
      name: it.name, tag, seconds: (Date.now() - t0) / 1000,
      modelCalls: mine.map(c => ({ model: c.model, ms: c.ms, status: c.status, finish: c.finish, error: c.error, usage: c.usage })),
      result: r, printed, lines, checks, raw: mine.map(c => c.content ?? null), error,
    };
    fs.writeFileSync(path.join(out, tag, `${it.name}.json`), JSON.stringify(record, null, 2));
    log(`${it.name.padEnd(26)} ${record.seconds.toFixed(1).padStart(5)}s  calls=${mine.length} ${mine.map(c => `${c.model}:${c.status}`).join(' ')}  total=${r ? r.total : '-'} ${r ? r.currency : ''}${error ? `  error: ${error}` : ''}`);
  }
  for (const s of skipped) log(`not read: ${s}`);
  log(`model requests this run: ${calls.length}`);
  fs.writeFileSync(path.join(out, tag, '_run.json'), JSON.stringify({ tag, at: new Date().toISOString(), calls: calls.length, skipped }, null, 2));
  return { calls: calls.length, skipped };
}

module.exports = { run };
