// How many PDF worker processes run at once. Each is a whole Node process
// with a PDF engine in it; twenty receipts uploaded together used to start
// up to forty of them on a two-core server. The rest wait their turn.
const MAX = Math.max(1, Number(process.env.PDF_WORKERS) || 2);
let running = 0;
const waiting = [];

function _acquire() {
  return new Promise(resolve => {
    const go = () => { running++; resolve(); };
    if (running < MAX) go(); else waiting.push(go);
  });
}
function _release() {
  running = Math.max(0, running - 1);
  const next = waiting.shift();
  if (next) next();
}
async function withSlot(fn) {
  await _acquire();
  try { return await fn(); } finally { _release(); }
}

module.exports = { withSlot, MAX };
