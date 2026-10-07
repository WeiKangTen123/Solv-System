// Pairs each receipt with the claim line it belongs to.
//
// The subtlety: matching must NOT lead on amount. If a receipt is matched to
// the row whose amount it equals, an amount mismatch becomes impossible to
// detect by construction — and detecting exactly that is the point. So date
// carries the most weight, amount is corroborating evidence, and a pair matched
// on date whose amounts disagree is reported rather than quietly re-matched.
//
// Neither field is unique on its own in real data: the sample form has three
// rows on 2026-02-26 and two amounts of 15.80. So every pair is scored and the
// best one-to-one assignment is taken, rather than matching greedily per row.

const DATE_EXACT = 100;
const DATE_NEAR  = 45;    // a day either side — timezone and posting-date drift
const AMOUNT_EXACT = 60;
const AMOUNT_NEAR  = 25;  // within 1%, for rounding
const TEXT_HINT    = 15;

// Two amounts agree if they round to the same cent: the one rule, shared with
// the duplicate check.
const { sameAmount } = require('../intake/dedup');

// An amount says something only when it is a positive figure. A claim line's 0
// is a formatted blank and null an empty cell: neither is a claim to agree or
// disagree with, and the reconciliation read "Claimed null but the receipt
// says 36". A negative one, compared as a ratio, was "within 1%" of every
// receipt there was.
const stated = v => typeof v === 'number' && v > 0;

function daysApart(a, b) {
  if (!a || !b) return null;
  const d = Math.abs(new Date(a) - new Date(b));
  return Number.isNaN(d) ? null : Math.round(d / 86400000);
}

// A weak signal, but it breaks ties: "Grab to meeting" against a Grab receipt.
function textOverlap(description, merchant) {
  if (!description || !merchant) return false;
  const words = String(merchant).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const hay = String(description).toLowerCase();
  return words.some(w => hay.includes(w));
}

function scorePair(row, receipt) {
  let score = 0;
  const reasons = [];

  const gap = daysApart(row.date, receipt.date);
  if (gap === 0)              { score += DATE_EXACT; reasons.push('same date'); }
  else if (gap !== null && gap <= 1) { score += DATE_NEAR; reasons.push('a day apart'); }

  if (stated(row.amount) && stated(receipt.total)) {
    if (sameAmount(row.amount, receipt.total)) { score += AMOUNT_EXACT; reasons.push('same amount'); }
    else if (Math.abs(row.amount - receipt.total) / row.amount <= 0.01) { score += AMOUNT_NEAR; reasons.push('amount within 1%'); }
  }

  if (textOverlap(row.description, receipt.merchant)) { score += TEXT_HINT; reasons.push('merchant named in the description'); }

  return { score, reasons };
}

// Below this a pair is not a match at all — better to report a claim line as
// having no receipt than to attach the wrong one to it.
const MIN_SCORE = 45;

function matchClaims(rows = [], receipts = []) {
  const pairs = [];
  rows.forEach((row, ri) => receipts.forEach((receipt, ei) => {
    const { score, reasons } = scorePair(row, receipt);
    if (score >= MIN_SCORE) pairs.push({ ri, ei, score, reasons });
  }));

  // Best-first one-to-one assignment. With claims in the tens, this is both
  // sufficient and easy to reason about; a full optimal assignment would be
  // harder to explain than the result is worth.
  pairs.sort((a, b) => b.score - a.score);
  const rowTaken = new Set(), receiptTaken = new Set();
  const matches = [];

  for (const p of pairs) {
    if (rowTaken.has(p.ri) || receiptTaken.has(p.ei)) continue;
    rowTaken.add(p.ri); receiptTaken.add(p.ei);
    const row = rows[p.ri], receipt = receipts[p.ei];
    // Only two stated amounts can agree or disagree. A pair matched on its date
    // with no claimed amount is neither verified nor a discrepancy.
    const comparable = stated(row.amount) && stated(receipt.total);
    const amountAgrees = comparable && sameAmount(row.amount, receipt.total);
    matches.push({
      row, receipt, score: p.score, reasons: p.reasons,
      amountAgrees,
      // The finding the whole exercise exists for.
      discrepancy: !comparable || amountAgrees ? null : {
        claimed: row.amount,
        onReceipt: receipt.total,
        // Rounded to the cent: 36 - 30.6 is 5.399999999999999 in binary floating
        // point, and a discrepancy shown to fifteen decimal places reads as a bug
        // in the tool rather than a problem with the claim.
        difference: Math.round((receipt.total - row.amount) * 100) / 100,
      },
    });
  }

  return {
    matches,
    // A claim line with nothing to support it.
    unmatchedRows: rows.filter((_, i) => !rowTaken.has(i)),
    // A receipt nobody claimed for.
    unmatchedReceipts: receipts.filter((_, i) => !receiptTaken.has(i)),
    summary: {
      total: rows.length > 0 ? rows.length : receipts.length,
      matched: matches.length,
      verified: matches.filter(m => m.amountAgrees).length,
      discrepancies: matches.filter(m => m.discrepancy).length,
      missingReceipts: rows.length - matches.length,
      extraReceipts: receipts.length - matches.length,
    },
  };
}

module.exports = { matchClaims, scorePair, sameAmount, stated, daysApart, textOverlap, MIN_SCORE };
