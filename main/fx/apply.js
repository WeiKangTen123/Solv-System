const store  = require('../store/expenses');
const users  = require('../store/users');
const rates  = require('./rates');
const logger = require('../utils/logger');
const { localDate } = require('../utils/zone-date');

// Puts a rate on every line of an expense and freezes it there. Which date
// the rate is for comes from the company policy; a rate a person typed in
// stays (its base amount follows the line's amount) until they ask for a
// refresh with force.
const toBase = (amount, rate) => Math.round(Math.round(amount * 100) * rate) / 100;

// The date a receipt is priced for, in the company's own calendar. It used to
// be UTC's: a receipt read before 08:00 in Singapore took the previous day's
// rate, and under the submission-date policy the date was "today" every time
// it was asked, so the nightly close moved a line on to the next day, and the
// next, for as long as it stayed open. Submission is when the receipt
// arrived, which does not move.
function policyDate(policy, expense, tz = 'Asia/Singapore') {
  const today = localDate(tz);
  if (policy === 'submission_date') return expense.createdAt ? localDate(tz, new Date(expense.createdAt)) : today;
  if (policy === 'monthly_fixed') return `${(expense.receiptDate || today).slice(0, 7)}-01`;
  return expense.receiptDate || today;
}

async function applyFx(expenseId, { force = false } = {}) {
  const e = store.getExpense(expenseId);
  if (!e) return { pending: 0, applied: 0 };
  const company = users.getCompany(e.companyId);
  const base = company.baseCurrency;
  const today = localDate(company.timezone);
  let pending = 0, applied = 0;

  const keepOverride = l => {
    if (force || !l.fxOverrideBy || !(l.fxRate > 0)) return false;
    store.updateLine(l.id, { baseAmount: toBase(l.amount, l.fxRate) });
    return true;
  };

  if (!e.currency || e.currency === base) {
    for (const l of e.lines) {
      if (keepOverride(l)) continue;
      store.updateLine(l.id, { fxRate: 1, fxRateDate: e.receiptDate || today, fxSource: 'base', fxFetchedAt: new Date().toISOString(), fxPolicy: company.fxPolicy, fxOverrideBy: null, fxOverrideReason: null, baseAmount: l.amount, fxAskedDate: e.receiptDate || today, fxCheck: null });
      applied++;
    }
    return { pending, applied };
  }

  const date = policyDate(company.fxPolicy, e, company.timezone);
  // The company's own today decides whether this day may take the live
  // board's figure (fx/live.js) or must be priced from its history.
  // Under a fixed monthly table only the table's rate will do, so the
  // providers are not asked for one that would be thrown away.
  let r = await rates.getRate({ from: e.currency, to: base, date, force, today, manualOnly: company.fxPolicy === 'monthly_fixed' });
  // A fixed monthly table is a promise finance made; a provider's number is not it.
  if (r && company.fxPolicy === 'monthly_fixed' && r.source !== 'manual') r = null;
  // A rate that moved further than a currency moves is not put on a line: the
  // line stays without one and says why, so nobody is paid a figure that came
  // from a provider having a bad morning. Finance settles it by entering the
  // rate, which is never blocked.
  const blocked = r && r.blocked ? r.blocked : null;
  const note = r && r.notes && r.notes.length ? r.notes.join('; ') : null;

  for (const l of e.lines) {
    if (keepOverride(l)) continue;
    if (!r || blocked) {
      store.updateLine(l.id, { fxRate: null, fxRateDate: date, fxSource: null, fxFetchedAt: null, fxPolicy: company.fxPolicy,
        fxOverrideBy: null, fxOverrideReason: null, baseAmount: null, fxAskedDate: date, fxCheck: blocked });
      pending++; continue;
    }
    store.updateLine(l.id, {
      fxRate: r.rate, fxRateDate: r.providerDate || r.rateDate, fxSource: r.source, fxFetchedAt: r.fetchedAt, fxPolicy: company.fxPolicy,
      fxOverrideBy: null, fxOverrideReason: null, baseAmount: toBase(l.amount, r.rate),
      fxAskedDate: date, fxCheck: note,
    });
    applied++;
  }
  if (pending) logger.info('Exchange rate pending', { expenseId, currency: e.currency, date, blocked: blocked || undefined });
  return { pending, applied, blocked, note };
}

// The claimant or finance types a rate. It is written to every line with the
// person and the reason, and survives a plain refresh.
// How far a rate somebody types may sit from the day's published rate. Card
// statements land within a couple of percent of the mid-market rate; a typed
// rate further out than this is a mistake or an inflated claim, and either
// way not one to freeze onto a line unasked. An admin is not held to it: they
// set rates for the company, and a provider glitch is exactly when theirs
// must differ.
const TYPED_RATE_TOLERANCE = 0.05;

// Why a rate this person typed for this expense would be refused, or null.
// Shared with the assistant, so it can say so before proposing one.
async function typedRateProblem(e, n, actor) {
  if (actor && actor.role === 'admin') return null;
  const company = users.getCompany(e.companyId);
  const date = policyDate(company.fxPolicy, e, company.timezone);
  const day = await rates.getRate({ from: e.currency, to: company.baseCurrency, date, today: localDate(company.timezone) }).catch(() => null);
  const ref = day ? day.rate : null;
  if (!(ref > 0)) return 'There is no published rate for this day to check yours against. Ask an admin to set it.';
  const off = Math.abs(n - ref) / ref;
  if (off > TYPED_RATE_TOLERANCE) {
    return `That is ${(off * 100).toFixed(1)}% from the day's rate of ${Number(ref.toPrecision(6))}. A rate you type may differ by at most ${TYPED_RATE_TOLERANCE * 100}%; ask an admin for anything further.`;
  }
  return null;
}

async function overrideFx(expenseId, { rate, reason, actor }) {
  const e = store.getExpense(expenseId);
  if (!e) throw new Error('Expense not found');
  const n = Number(rate);
  if (!(n > 0) || !Number.isFinite(n)) throw new Error('A rate must be a number above zero');
  if (!reason || !String(reason).trim()) throw new Error('Say why the rate is being changed');
  const problem = await typedRateProblem(e, n, actor);
  if (problem) throw new Error(problem);
  for (const l of e.lines) {
    store.updateLine(l.id, {
      fxRate: n, fxRateDate: e.receiptDate || localDate(users.getCompany(e.companyId).timezone), fxSource: 'manual', fxFetchedAt: new Date().toISOString(),
      fxOverrideBy: (actor && (actor.email || actor.id)) || 'unknown', fxOverrideReason: String(reason).trim().slice(0, 200), baseAmount: toBase(l.amount, n),
      fxCheck: null,
    });
  }
  logger.info('Exchange rate overridden', { expenseId, rate: n, by: actor && actor.id });
  return store.getExpense(expenseId);
}

module.exports = { applyFx, overrideFx, typedRateProblem, policyDate, toBase, TYPED_RATE_TOLERANCE };
