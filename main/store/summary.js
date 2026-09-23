const db = require('../db');
const { toDollars } = require('./expenses');

// The numbers behind the dashboard, aggregated in SQL.
//
// Deliberately not computed in the browser. An employee could fetch their own
// expenses and add them up, but finance's view is every expense in the company
// and a page that downloads all of them to count them stops working at exactly
// the size where somebody would want a dashboard.
//
// Money is summed from expense_lines.base_cents, never from the expense: a
// receipt split four ways carries its money on the lines, and a line still
// waiting for an exchange rate has no base_cents at all. Those lines are
// counted separately rather than folded in as zero, so a figure that is
// incomplete says so.

const MONTHS = 6;

// Which people's expenses this person may see totalled: their own, or the
// company for an admin. The company case is a column filter rather than an id
// list, because a company of any size should not become an IN list.
function _scope(me) {
  if (me.role === 'admin') return { kind: 'company', companyId: me.companyId };
  return { kind: 'own', userIds: [me.id] };
}

function _where(scope, alias = 'e') {
  if (scope.kind === 'company') return { sql: `${alias}.company_id = ?`, args: [scope.companyId] };
  return { sql: `${alias}.user_id IN (${scope.userIds.map(() => '?').join(',')})`, args: [...scope.userIds] };
}

// Which month it is where the company is, as YYYY-MM. Receipt dates are plain
// dates written in the claimant's own day, so the window they are matched
// against has to be the company's day too. Asked in UTC, the chart called
// September "this month" for the first eight hours of every October in
// Singapore, and dropped a receipt dated the 1st out of the window entirely.
function _thisMonth(now, tz) {
  try {
    // en-CA renders as YYYY-MM-DD, which is the shape the rest of this works in.
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).slice(0, 7);
  } catch {
    // An unknown zone is a misconfiguration, not a reason to answer nothing.
    return now.toISOString().slice(0, 7);
  }
}

// The six months ending with this one, oldest first. Built in JS rather than
// SQL so a month with no expenses in it is still a column on the chart instead
// of a gap the eye reads as continuous.
function _monthKeys(now = new Date(), tz = 'UTC') {
  const [y, m] = _thisMonth(now, tz).split('-').map(Number);
  const out = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// Expenses are dated by the receipt, not by when somebody got round to filing
// them: a hotel bill from August belongs to August however late it is claimed.
// Rows with no receipt date fall back to when they were created.
const DATED = "COALESCE(NULLIF(e.receipt_date, ''), e.created_at)";
const LIVE = "e.status NOT IN ('duplicate', 'rejected')";

function summary(me, { now = new Date(), timezone = 'UTC' } = {}) {
  const scope = _scope(me);
  const w = _where(scope);
  const months = _monthKeys(now, timezone);
  const from = `${months[0]}-01`;

  const byMonth = db.prepare(`
    SELECT substr(${DATED}, 1, 7) AS month, SUM(l.base_cents) AS cents, COUNT(DISTINCT e.id) AS n
    FROM expenses e JOIN expense_lines l ON l.expense_id = e.id
    WHERE ${w.sql} AND ${LIVE} AND l.base_cents IS NOT NULL AND ${DATED} >= ?
    GROUP BY 1`).all(...w.args, from);
  const found = new Map(byMonth.map(r => [r.month, r]));
  const series = months.map(m => ({ month: m, base: toDollars(found.get(m)?.cents) ?? 0, count: found.get(m)?.n ?? 0 }));

  const byCategory = db.prepare(`
    SELECT COALESCE(NULLIF(l.category, ''), e.category, 'Uncategorised') AS category,
           SUM(l.base_cents) AS cents, COUNT(*) AS n
    FROM expenses e JOIN expense_lines l ON l.expense_id = e.id
    WHERE ${w.sql} AND ${LIVE} AND l.base_cents IS NOT NULL AND ${DATED} >= ?
    GROUP BY 1 ORDER BY cents DESC`).all(...w.args, from);

  const byCurrency = db.prepare(`
    SELECT COALESCE(NULLIF(l.currency, ''), e.currency, '?') AS currency,
           SUM(l.base_cents) AS cents, COUNT(DISTINCT e.id) AS n
    FROM expenses e JOIN expense_lines l ON l.expense_id = e.id
    WHERE ${w.sql} AND ${LIVE} AND l.base_cents IS NOT NULL AND ${DATED} >= ?
    GROUP BY 1 ORDER BY cents DESC`).all(...w.args, from);

  // Lines nobody could price. Reported rather than folded into the totals as
  // zero, because a chart that quietly omits money is worse than one that says
  // how much it is missing.
  const unpriced = db.prepare(`
    SELECT COUNT(*) AS n FROM expenses e JOIN expense_lines l ON l.expense_id = e.id
    WHERE ${w.sql} AND ${LIVE} AND l.base_cents IS NULL AND ${DATED} >= ?`).get(...w.args, from);

  const rw = _where(scope, 'r');
  // How long a case stays open before it is claimed, in days, over cases that
  // have been. julianday subtracts two timestamps directly; AVG over an empty
  // set is NULL, which is reported as null rather than 0 — "no data" and
  // "instant" are not the same answer.
  const cycle = db.prepare(`
    SELECT AVG(julianday(r.claimed_at) - julianday(r.created_at)) AS open_days,
           COUNT(r.claimed_at) AS claimed_n,
           SUM(CASE WHEN r.status = 'open' THEN 1 ELSE 0 END) AS open_n
    FROM expense_reports r WHERE ${rw.sql}`).get(...rw.args);

  const totalCents = db.prepare(`
    SELECT SUM(CASE WHEN r.status = 'claimed' OR e.claimed_at IS NOT NULL THEN l.base_cents ELSE 0 END) AS claimed,
           SUM(CASE WHEN (r.status = 'open' OR r.id IS NULL) AND e.claimed_at IS NULL THEN l.base_cents ELSE 0 END) AS open_cents
    FROM expenses e JOIN expense_lines l ON l.expense_id = e.id
    LEFT JOIN expense_reports r ON r.id = e.report_id
    WHERE ${w.sql} AND ${LIVE} AND l.base_cents IS NOT NULL AND ${DATED} >= ?`).get(...w.args, from);

  const total = toDollars(byCategory.reduce((s, r) => s + (r.cents || 0), 0)) ?? 0;
  const share = cents => (total > 0 ? Math.round(((toDollars(cents) ?? 0) / total) * 1000) / 1000 : 0);
  const round1 = n => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

  return {
    scope: scope.kind,
    base: me.baseCurrency || 'SGD',
    timezone,
    months: series,
    thisMonth: series[series.length - 1].base,
    lastMonth: series.length > 1 ? series[series.length - 2].base : 0,
    total,
    byCategory: byCategory.map(r => ({ category: r.category, base: toDollars(r.cents) ?? 0, lines: r.n, share: share(r.cents) })),
    byCurrency: byCurrency.map(r => ({ currency: r.currency, base: toDollars(r.cents) ?? 0, receipts: r.n, share: share(r.cents) })),
    unpricedLines: unpriced?.n ?? 0,
    cycle: { openToClaimed: round1(cycle?.open_days ?? null), claimedCount: cycle?.claimed_n ?? 0, openCount: cycle?.open_n ?? 0 },
    claimed: toDollars(totalCents?.claimed) ?? 0,
    open: toDollars(totalCents?.open_cents) ?? 0,
    monthsCovered: MONTHS,
  };
}

module.exports = { summary, _monthKeys, _scope, MONTHS };
