// A case's cover as a request sends it, checked and cleaned into what the
// store takes. One rule for every way the cover is written: the case routes
// (create, PATCH, Create case) and the assistant's details card, which is
// held to exactly what the page could save.
//
// Throws an Error whose message is meant for the person; the caller answers
// it as a 400 (a route) or as the tool's refusal (the assistant).
const COVER = ['kind', 'title', 'purpose', 'periodFrom', 'periodTo', 'destination', 'nights', 'advances', 'notes'];
const KINDS = ['trip', 'period', 'case'];
const MAX_ADVANCE = 10000000;
// The cover's words, each text and of a sane length. An object for a title
// reached the database driver, whose own message ("Too few parameter values")
// came back to the person as the error.
const TEXT_MAX = { title: 200, purpose: 500, destination: 120, notes: 2000 };

function coverPatch(body) {
  const patch = {};
  const src = body && typeof body === 'object' ? body : {};
  for (const k of COVER) if (src[k] !== undefined) patch[k] = src[k] === '' ? null : src[k];
  for (const [k, max] of Object.entries(TEXT_MAX)) {
    if (patch[k] === undefined || patch[k] === null) continue;
    if (typeof patch[k] !== 'string') throw new Error(`${k[0].toUpperCase()}${k.slice(1)} must be text`);
    patch[k] = patch[k].trim().slice(0, max) || null;
  }
  for (const k of ['periodFrom', 'periodTo']) {
    if (patch[k] && !require('../intake/document').isoDate(String(patch[k]), { allowFuture: true })) throw new Error(`${k === 'periodFrom' ? 'From' : 'To'} must be a real date, YYYY-MM-DD`);
  }
  // 'case' was added to the store, the schema and the printed cover and missed
  // here, so every case created through the UI was refused by its own route.
  if (patch.kind && !KINDS.includes(patch.kind)) throw new Error('kind must be trip, period or case');
  // A finite amount, and not an absurd one: "1e400" passed ">= 0" as
  // Infinity, showed as 0.00 on screen and printed as "∞" on the PDF.
  if (patch.advances !== undefined && patch.advances !== null) {
    const n = Number(patch.advances);
    if (!Number.isFinite(n) || n < 0 || n > MAX_ADVANCE) throw new Error(`Advances must be an amount from 0 to ${MAX_ADVANCE.toLocaleString('en')}`);
  }
  if (patch.nights !== undefined && patch.nights !== null) patch.nights = Number(patch.nights) >= 0 ? Math.round(Number(patch.nights)) : null;
  return patch;
}

// Whether a cover field already holds a value: nothing and an empty string
// are the same, and so are 3 and "3". The assistant's card leaves out what
// would not change, and refuses on Apply once a value has moved since.
function sameCover(a, b) {
  const blank = v => v === null || v === undefined || v === '';
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

module.exports = { coverPatch, sameCover, COVER, KINDS, TEXT_MAX, MAX_ADVANCE };
