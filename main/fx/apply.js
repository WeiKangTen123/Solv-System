const store  = require('../store/expenses');
const users  = require('../store/users');
const rates  = require('./rates');
const logger = require('../utils/logger');

// Puts a rate on every line of an expense and freezes it there. Which date
// the rate is for comes from the company policy; a rate a person typed in
// stays (its base amount follows the line's amount) until they ask for a
// refresh with force.
const today = () => new Date().toISOString().slice(0, 10);
const toBase = (amount, rate) => Math.round(Math.round(amount * 100) * rate) / 100;

function policyDate(policy, expense) {
  if (policy === 'submission_date') return today();
  if (policy === 'monthly_fixed') return `${(expense.receiptDate || today()).slice(0, 7)}-01`;
  return expense.receiptDate || today();
}

async function applyFx(expenseId, { force = false } = {}) {
  const e = store.getExpense(expenseId);
  if (!e) return { pending: 0, applied: 0 };
  const company = users.getCompany(e.companyId);
  const base = company.baseCurrency;
  let pending = 0, applied = 0;

  const keepOverride = l => {
    if (force || !l.fxOverrideBy || !(l.fxRate > 0)) return false;
    store.updateLine(l.id, { baseAmount: toBase(l.amount, l.fxRate) });
    return true;
  };

  if (!e.currency || e.currency === base) {
    for (const l of e.lines) {
      if (keepOverride(l)) continue;
      store.updateLine(l.id, { fxRate: 1, fxRateDate: e.receiptDate || today(), fxSource: 'base', fxFetchedAt: new Date().toISOString(), fxPolicy: company.fxPolicy, fxOverrideBy: null, fxOverrideReason: null, baseAmount: l.amount, fxAskedDate: e.receiptDate || today(), fxCheck: null });
      applied++;
    }
    return { pending, applied };
  }

  const date = policyDate(company.fxPolicy, e);
  let r = await rates.getRate({ from: e.currency, to: base, date });
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
async function overrideFx(expenseId, { rate, reason, actor }) {
  const e = store.getExpense(expenseId);
  if (!e) throw new Error('Expense not found');
  const n = Number(rate);
  if (!(n > 0)) throw new Error('A rate must be a number above zero');
  if (!reason || !String(reason).trim()) throw new Error('Say why the rate is being changed');
  for (const l of e.lines) {
    store.updateLine(l.id, {
      fxRate: n, fxRateDate: e.receiptDate || today(), fxSource: 'manual', fxFetchedAt: new Date().toISOString(),
      fxOverrideBy: (actor && (actor.email || actor.id)) || 'unknown', fxOverrideReason: String(reason).trim().slice(0, 200), baseAmount: toBase(l.amount, n),
      fxCheck: null,
    });
  }
  logger.info('Exchange rate overridden', { expenseId, rate: n, by: actor && actor.email, reason });
  return store.getExpense(expenseId);
}

module.exports = { applyFx, overrideFx, policyDate, toBase };
