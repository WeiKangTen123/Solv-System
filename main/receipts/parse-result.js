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

module.exports = { firstReceipt, readSomething };
