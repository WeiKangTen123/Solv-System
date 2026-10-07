// What a read came back with, asked the same way by the reader
// (receipt-parser.js) and by what it reads for (read-receipt.js). A read is
// { receipts, split, reason }, or null when nothing usable came back; the
// list can be empty when the model said there is no receipt there, or when
// the AI service could not be reached (unavailable: true).

// The receipt a read is about when it is not split: the first, or null.
function firstReceipt(parsed) {
  return parsed && Array.isArray(parsed.receipts) && parsed.receipts.length ? parsed.receipts[0] : null;
}

// An answer with neither a merchant nor a total read nothing: a blank page, a
// cover sheet, a photo of the desk.
function readSomething(r) {
  return !!r && ((r.total !== null && r.total !== undefined) || !!r.merchant);
}

// How much two receipt boxes ([ymin, xmin, ymax, xmax], 0-1000) overlap, as a
// share of the SMALLER: a small box wholly inside a large one is 1. The
// reader asks it to decide a split, a re-read to find its own half again.
function area(b) { return (b[2] - b[0]) * (b[3] - b[1]); }
function overlapFraction(a, b) {
  const dy = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const dx = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (dy <= 0 || dx <= 0) return 0;
  return (dy * dx) / Math.min(area(a), area(b));
}

module.exports = { firstReceipt, readSomething, area, overlapFraction };
