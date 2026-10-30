// How well the reader reads: draws the synthetic receipts, reads them and the
// two sample folios with the live model, and scores what came back.
//
//   npm run eval:reader -- [--env main/.env] [--out <dir>] [--tag run]
//                          [--only a,b] [--samples samples/receipts]
//                          [--max-calls 30] [--score-only] [--compare a,b]
//
//   --env        the file the Gemini key is read from (only the key is taken)
//   --out        where the images, replies and logs go; outside the repository
//                by default, since replies from real folios are personal data
//   --tag        the name of this run's folder under --out
//   --only       read just these receipts
//   --samples    the folder holding the sample folios (they are not in git)
//   --max-calls  stop reading once this many model requests have been made
//   --score-only score runs already saved, and call nothing
//   --compare    score two saved runs side by side, e.g. before,after
//
// It costs one model request a receipt, about eighteen, and is never run by
// the test suite.
const path = require('path');
const os = require('os');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

(async () => {
  const root = path.join(__dirname, '../../..');
  const a = args(process.argv.slice(2));
  const out = path.resolve(a.out || path.join(os.tmpdir(), 'solv-eval'));
  const tag = a.tag || 'run';
  const { report } = require('./score');
  if (a.compare) { report(out, String(a.compare).split(',')); return; }
  if (!a['score-only']) {
    const only = a.only ? String(a.only).split(',') : null;
    await require('./make-synth').makeSynth(out, { only });
    await require('./run').run({
      env: path.resolve(a.env || path.join(root, 'main/.env')), out, tag, only,
      samplesDir: path.resolve(a.samples || path.join(root, 'samples/receipts')),
      maxCalls: a['max-calls'] ? Number(a['max-calls']) : 30,
    });
  }
  report(out, [tag]);
})().catch(err => { console.error(err.message || err); process.exit(1); });
