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

// Which people's expenses this person may see totalled. An employee sees their
// own; a manager their direct reports and themselves; finance and admin the
// company. Returned as an explicit id list except for the company case, which
// is a column filter — a company of any size should not become an IN list.
function _scope(me, allUsers) {
  if (me.role === 'finance' || me.role === 'admin') return { kind: 'company', companyId: me.companyId };
  if (me.role === 'manager') {
    const ids = allUsers.filter(u => u.managerId === me.id).map(u => u.id);
    return { kind: 'team', userIds: [...new Set([me.id, ...ids])] };
  }
  return { kind: 'own', userIds: [me.id] };
}

function _where(scope, alias = 'e') {
  if (scope.kind === 'company') return { sql: `${alias}.company_id = ?`, args: [scope.companyId] };
  return { sql: `${alias}.user_id IN (${scope.userIds.map(() => '?').join(',')})`, args: [...scope.userIds] };
}

// The six months ending with this one, as YYYY-MM, oldest first. Built in JS
// rather than SQL so a month with no expenses in it is still a column on the
// chart instead of a gap the eye reads as continuous.
function _monthKeys(now = new Date()) {
  const out = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// Expenses are dated by the receipt, not by when somebody got round to filing
// them: a hotel bill from August belongs to August however late it is claimed.
// Rows with no receipt date fall back to when they were created.
const DATED = "COALESCE(NULLIF(e.receipt_date, ''), e.created_at)";
const LIVE = "e.status NOT IN ('duplicate', 'rejected')";

function summary(me, allUsers, { now = new Date() } = {}) {
  const scope = _scope(me, allUsers);
  const w = _where(scope);
  const months = _monthKeys(now);
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
  // How long each hop actually takes, in days, over reports that completed it.
  // julianday subtracts two timestamps directly; AVG over an empty set is NULL,
  // which is reported as null rather than 0 — "no data" and "instant" are not
  // the same answer.
  const cycle = db.prepare(`
    SELECT AVG(julianday(r.approved_at) - julianday(r.submitted_at)) AS to_approve,
           COUNT(r.approved_at) AS approved_n,
           AVG(julianday(r.claimed_at) - julianday(r.approved_at)) AS to_claim,
           COUNT(r.claimed_at) AS claimed_n
    FROM expense_reports r WHERE ${rw.sql} AND r.submitted_at IS NOT NULL`).get(...rw.args);

  const totalCents = db.prepare(`
    SELECT SUM(CASE WHEN r.status = 'claimed' THEN l.base_cents ELSE 0 END) AS claimed,
           SUM(CASE WHEN r.status = 'approved' THEN l.base_cents ELSE 0 END) AS awaiting
    FROM expenses e JOIN expense_lines l ON l.expense_id = e.id
    LEFT JOIN expense_reports r ON r.id = e.report_id
    WHERE ${w.sql} AND ${LIVE} AND l.base_cents IS NOT NULL AND ${DATED} >= ?`).get(...w.args, from);

  const total = toDollars(byCategory.reduce((s, r) => s + (r.cents || 0), 0)) ?? 0;
  const share = cents => (total > 0 ? Math.round(((toDollars(cents) ?? 0) / total) * 1000) / 1000 : 0);
  const round1 = n => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

  return {
    scope: scope.kind,
    base: me.baseCurrency || 'SGD',
    months: series,
    thisMonth: series[series.length - 1].base,
    lastMonth: series.length > 1 ? series[series.length - 2].base : 0,
    total,
    byCategory: byCategory.map(r => ({ category: r.category, base: toDollars(r.cents) ?? 0, lines: r.n, share: share(r.cents) })),
    byCurrency: byCurrency.map(r => ({ currency: r.currency, base: toDollars(r.cents) ?? 0, receipts: r.n, share: share(r.cents) })),
    unpricedLines: unpriced?.n ?? 0,
    cycle: {
      submitToApprove: round1(cycle?.to_approve ?? null), approvedCount: cycle?.approved_n ?? 0,
      approveToClaim: round1(cycle?.to_claim ?? null), claimedCount: cycle?.claimed_n ?? 0,
    },
    claimed: toDollars(totalCents?.claimed) ?? 0,
    awaitingClaim: toDollars(totalCents?.awaiting) ?? 0,
    monthsCovered: MONTHS,
  };
}

module.exports = { summary, _monthKeys, _scope, MONTHS };
