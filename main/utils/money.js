// An amount as people read it: two decimals, thousands separated, the same
// on every server whatever its locale. One definition; it was written out
// four times (the change log, the assistant, the printed report, the Xero
// bill). What an empty amount reads as differs by place, so callers say.
function formatAmount(n, { empty = '0.00' } = {}) {
  if (n === null || n === undefined || n === '') return empty;
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { formatAmount };
