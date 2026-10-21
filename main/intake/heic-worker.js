const { parentPort, workerData } = require('worker_threads');

// Decodes one HEIC photo off the server's main thread (intake/convert.js).
// heic-decode is libheif compiled to WebAssembly and does its work
// synchronously: about a tenth of a second per megapixel here, so a 12 MP
// iPhone photo held every request on the server for over a second. In a
// worker it holds nothing but itself.
//
// Answers { width, height, data } with the RGBA pixels transferred rather than
// copied, or { error }.
const decode = require('heic-decode');

const input = workerData && workerData.buffer;
const bytes = input ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : Buffer.alloc(0);
decode({ buffer: bytes })
  .then(({ width, height, data }) => parentPort.postMessage({ width, height, data }, [data.buffer]))
  .catch(err => parentPort.postMessage({ error: String((err && err.message) || err) }));
