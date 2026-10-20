import { formatDate } from '../../utils/formatDate';

// What the exchange-rate board and its currency window share: how a rate's
// day, its inverse and its move are printed, and the names of the groups.

export const KIND = {
  live: 'Live, closes tonight',
  close: 'Daily close',
  lookup: 'Provider rate for the day',
  manual: 'Set by an admin',
};

// The board's groups, in the order they are listed. A currency's region comes
// from the server (main/intake/currencies.js); one it does not know is 'other'.
export const REGIONS = [
  ['asia', 'Asia'],
  ['west', 'Europe & Americas'],
  ['other', 'Other'],
];

export const num = { fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' };
export const muted = { fontSize: 11.5, color: 'var(--text-muted)' };

// "1 SGD = 75.22 INR": two places once the number is big enough to read that
// way, four significant figures when it is small.
export function fmtInverse(n) {
  if (!(n > 0)) return '';
  if (n >= 10) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return Number(n.toPrecision(4)).toString();
}

// The direction of the move with its size. Movement is not a state, so it
// carries no colour: colour on this app means something needs you.
export function fmtChange(c) {
  if (c === null || c === undefined || !Number.isFinite(c)) return '—';
  const pct = Math.abs(c * 100);
  if (pct < 0.005) return '0.00%';
  return `${c > 0 ? '▲' : '▼'} ${pct.toFixed(2)}%`;
}

export const zoneLabel = tz => (tz === 'Asia/Singapore' ? 'SGT' : tz);

// A rate's day is a calendar date, not a moment: "2026-10-05" is 5 Oct
// everywhere. Formatted in UTC so a company west of Greenwich does not see
// the day before.
export const fmtDay = iso => (iso ? formatDate(`${String(iso).slice(0, 10)}T00:00:00Z`, 'UTC') : '—');
