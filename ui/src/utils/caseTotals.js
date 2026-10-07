// Receipts in a case that add nothing to its total yet, and why.
//
// Two different waits. A receipt with no amount (the reader could not make it
// out) is waiting for its owner to type one; a receipt with an amount in
// another currency is waiting for an exchange rate. Both used to be counted
// together as `pendingRates` and shown as "waiting for an exchange rate",
// which sent people looking for a rate problem on a receipt nobody had
// filled in. The server now counts `noAmount` apart; when a reply has no
// `noAmount`, `pendingRates` still holds both and is called what it is.
export function unpriced(t) {
  const pending = Number(t && t.pendingRates) || 0;
  if (!t || t.noAmount === undefined || t.noAmount === null) return { noAmount: 0, noRate: 0, either: pending };
  return { noAmount: Number(t.noAmount) || 0, noRate: pending, either: 0 };
}

export function unpricedCount(t) {
  const u = unpriced(t);
  return u.noAmount + u.noRate + u.either;
}

// "2 without an amount yet, 1 waiting for an exchange rate", or ''.
export function unpricedText(t, { short = false } = {}) {
  const u = unpriced(t);
  return [
    u.noAmount ? `${u.noAmount} without an amount yet` : '',
    u.noRate ? `${u.noRate} waiting for ${short ? 'a rate' : 'an exchange rate'}` : '',
    u.either ? `${u.either} without an amount or rate yet` : '',
  ].filter(Boolean).join(', ');
}
