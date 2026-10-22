const db       = require('../db');
const store    = require('../store/expenses');
const reports  = require('../store/reports');
const users    = require('../store/users');
const policy   = require('../store/policy');
const wf       = require('./workflow');
const coverAuto = require('./cover-auto');
const { isOwner } = require('../middleware/roles');
const { fail } = require('../utils/http-error');
const { CURRENCY_COUNTRY, countryName, dayRange } = require('./cover-suggest');
const { localDate, addDays } = require('../utils/zone-date');
const { isoDate } = require('../intake/document');
const { formatAmount } = require('../utils/money');
const logger   = require('../utils/logger');

// Claims with no receipt behind them, worked out from the company's own
// rates (store/policy.js): a per diem for the days of a trip, and mileage for
// a drive. Each is one expense in the case, already checked, because there is
// nothing on paper to check it against; it prints, claims and posts to Xero
// like any receipt, with no file attached (the claim import makes rows like
// it already).
//
// The person asks and the server works it out: the amount is never taken from
// the browser, so a per diem is always the company's rate for the company's
// days, and mileage always the company's rate per km.

const PER_DIEM = 'per_diem', MILEAGE = 'mileage';
const ALLOWANCE_SOURCES = new Set([PER_DIEM, MILEAGE]);
// A per diem for longer than a year is a pair of dates typed wrong.
const MAX_DAYS = 366;
const MAX_KM = 5000;
const TEXT_MAX = { from: 120, to: 120, purpose: 500 };
const OWNER_ONLY = 'Only the person whose case this is can change it.';

// The case, if this person may add to it now: theirs, and still taking
// receipts. Who may is a 403 and the state a 409, as for every case route.
function _editableCase(reportId, actor) {
  const r = reports.getReport(reportId);
  if (!r) fail(404, 'Case not found');
  if (!isOwner(actor, r.userId, r.companyId)) fail(403, OWNER_ONLY);
  if (!wf.isEditable(r)) fail(409, `A ${r.status} case cannot be changed.`);
  return r;
}

// "4,000" for a round figure, "4,000.50" otherwise: a rate reads as people
// write it, and the amount itself is printed with its cents everywhere else.
const _amount = n => (Number.isInteger(Number(n)) ? Number(n).toLocaleString('en-US') : formatAmount(n));
const _pct = n => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
const _day = d => dayRange(d, d);
const _days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const _plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ── Which country ────────────────────────────────────────────────────────────
// Every name the date library knows, to a code, built once when first asked:
// "Pune, India" typed as the destination says India.
let _byName = null;
function _countryInText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (!_byName) {
    _byName = new Map();
    const A = 65;
    for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      const name = countryName(code);
      if (name) _byName.set(name.toLowerCase(), code);
    }
  }
  const parts = text.split(/[,;/]/).map(s => s.trim().toLowerCase()).filter(Boolean).reverse();
  for (const p of parts) if (_byName.has(p)) return _byName.get(p);
  return null;
}

// Most frequent first, a tie to the one seen first, so the same receipts
// always give the same country.
function _mostCommon(values) {
  const n = new Map();
  for (const v of values) if (v) n.set(v, (n.get(v) || 0) + 1);
  let best = null;
  for (const [v, c] of n) if (!best || c > n.get(best)) best = v;
  return best;
}

// The country a trip's per diem is for, when the person did not say: where
// most of its foreign receipts were printed; failing that, the country of the
// foreign currency they were paid in (the rule cover-suggest.js names a trip
// by); failing that, a country named in the destination. Home is never
// guessed: a per diem at home is asked for by name.
function perDiemCountry(report, baseCurrency) {
  const base = String(baseCurrency || 'SGD').toUpperCase();
  const home = CURRENCY_COUNTRY[base] || 'SG';
  const usable = (report.expenses || []).filter(e => !ALLOWANCE_SOURCES.has(e.source) && !['reading', 'duplicate', 'rejected'].includes(e.status));
  const printed = usable.map(e => (typeof e.country === 'string' ? e.country.toUpperCase() : null)).filter(c => c && /^[A-Z]{2}$/.test(c) && c !== home);
  const byCurrency = usable.map(e => (e.currency && e.currency !== base ? CURRENCY_COUNTRY[e.currency] : null)).filter(c => c && c !== home);
  return _mostCommon(printed) || _mostCommon(byCurrency) || _countryInText(report.destination);
}

// ── Per diem ─────────────────────────────────────────────────────────────────
// Each day of the trip at the rate for that day, so a rate that changed
// mid-trip is honoured; the first and last day at the travel-day share, or a
// one-day trip at that share once. Returns what it worked out, or a 400 that
// says why it cannot.
function perDiemPlan({ companyId, country, from, to, travelDayPct = 100 }) {
  const name = countryName(country) || country;
  const count = _days(from, to) + 1;
  if (count < 1) fail(400, 'The trip ends before it starts. Correct its dates first.');
  if (count > MAX_DAYS) fail(400, `A per diem covers at most ${MAX_DAYS} days, and this trip is ${count}. Check its dates.`);
  const share = travelDayPct / 100;
  const days = [];
  for (let i = 0; i < count; i++) {
    const date = addDays(from, i);
    const rate = policy.rateFor(companyId, country, date);
    if (!rate) {
      // Rates run on from their date, so a missing day is one before the first.
      const any = policy.listRates(companyId).filter(x => x.country === country);
      if (!any.length) fail(400, `There is no per-diem rate for ${name}. An admin adds per-diem rates in Settings.`);
      const first = any[any.length - 1];
      fail(400, `The per-diem rate for ${name} starts on ${_day(first.effectiveFrom)}, after this trip's first day (${_day(date)}). An admin can add an earlier rate in Settings.`);
    }
    const weight = count === 1 || i === 0 || i === count - 1 ? share : 1;
    days.push({ date, weight, rate });
  }
  const currencies = [...new Set(days.map(d => d.rate.currency))];
  if (currencies.length > 1) {
    fail(400, `The per-diem rates for ${name} during this trip are in ${currencies.join(' and ')}, and one per diem is in one currency. Ask an admin to keep ${name}'s rates in one currency.`);
  }
  const currency = currencies[0];
  const totalCents = Math.round(days.reduce((s, d) => s + store.toCents(d.rate.dailyAmount) * d.weight, 0));
  if (!(totalCents > 0)) fail(400, `With the first and last day at ${_pct(travelDayPct)}, a trip of ${_plural(count, 'day')} has no per diem.`);

  // "4 days (first and last at 75%) × INR 4,000". A rate that changed
  // mid-trip says each rate with the days it priced.
  const runs = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && last.amount === d.rate.dailyAmount) last.to = d.date;
    else runs.push({ amount: d.rate.dailyAmount, from: d.date, to: d.date });
  }
  const span = count === 1 ? `1 day${travelDayPct === 100 ? '' : ` at ${_pct(travelDayPct)}`}`
    : `${count} days${travelDayPct === 100 ? '' : ` (first and last at ${_pct(travelDayPct)})`}`;
  const rates = runs.length === 1 ? `${currency} ${_amount(runs[0].amount)}`
    : `${currency} ${runs.map(x => `${_amount(x.amount)} (${dayRange(x.from, x.to)})`).join(', ')}`;
  return { country, countryName: name, currency, total: totalCents / 100, days: count, description: `Per diem, ${name}: ${span} × ${rates}` };
}

// "Add per diem" on a Trip: one expense for the trip's days at the
// destination's rate, replacing the one there was. Returns { report, expense }.
async function addPerDiem(reportId, actor, body = {}) {
  const r = _editableCase(reportId, actor);
  if (r.kind !== 'trip') fail(400, 'A per diem is for a Trip. Change this case to a Trip first.');
  const missing = [!r.periodFrom && 'first', !r.periodTo && 'last'].filter(Boolean);
  if (missing.length) fail(400, `Set the trip's ${missing.join(' and ')} day before adding a per diem.`);

  const company = users.getCompany(r.companyId) || {};
  let country = null;
  if (body.country !== undefined && body.country !== null && body.country !== '') {
    country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(country) || !countryName(country)) fail(400, 'The country must be a two-letter country code, such as IN for India.');
  } else {
    country = perDiemCountry(r, company.baseCurrency);
    if (!country) fail(400, 'Say which country the per diem is for: none of the receipts in this case says where the trip was.');
  }

  const p = policy.getPolicy(r.companyId);
  const plan = perDiemPlan({ companyId: r.companyId, country, from: r.periodFrom, to: r.periodTo, travelDayPct: p.travelDayPct });
  const old = r.expenses.filter(e => e.source === PER_DIEM && e.userId === r.userId);
  // The old one goes and the new one comes in one step: two per diems for
  // one trip, or none, would each be a wrong claim.
  const expense = db.transaction(() => {
    for (const e of old) store.deleteExpense(e.id);
    return store.createExpense({
      companyId: r.companyId, userId: r.userId, reportId: r.id, source: PER_DIEM, merchant: 'Per diem', category: 'Meals',
      currency: plan.currency, total: plan.total, receiptDate: r.periodFrom, description: plan.description, country,
      status: 'reviewed', lines: [{ category: 'Meals', description: plan.description, amount: plan.total, currency: plan.currency }],
    });
  })();
  reports.addEvent(r.id, actor.id, 'edited', `${old.length ? 'Per diem replaced' : 'Per diem added'}: ${plan.description.replace(/^Per diem, /, '')}`);
  await _price(expense.id);
  coverAuto.refresh(r.id);
  logger.info('Per diem added', { reportId: r.id, expenseId: expense.id, country, days: plan.days, currency: plan.currency, total: plan.total, replaced: old.length, by: actor.id });
  return { report: reports.getReport(r.id), expense: store.getExpense(expense.id) };
}

// A rate the providers cannot give now is not a reason to lose the claim: the
// line waits without one, says so (receipts/flags.js no-rate), and the
// sweeper prices it, as for any receipt.
async function _price(expenseId) {
  try { await require('../fx/apply').applyFx(expenseId); }
  catch (err) { logger.warn('Exchange rate not applied to an allowance', { expenseId, error: err.message }); }
}

// ── Mileage ──────────────────────────────────────────────────────────────────
function _text(v, key, label) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') fail(400, `${label} must be text.`);
  return v.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX[key]) || null;
}
const TRUE = new Set([true, 1, '1', 'true']), FALSE = new Set([false, 0, '0', 'false', undefined, null, '']);
// "0.60", "0.585": at least the two places money has, and the rate's own.
function _rate(n) {
  const places = (String(n).split('.')[1] || '').length;
  return Number(n).toFixed(Math.min(4, Math.max(2, places)));
}

// "Add mileage": a drive at the company's rate per km, in the base currency.
// Returns { report, expense }.
async function addMileage(reportId, actor, body = {}) {
  const r = _editableCase(reportId, actor);
  const rate = policy.getPolicy(r.companyId).mileageRatePerKm;
  if (!rate) fail(400, 'Your company has no mileage rate yet. An admin sets it in Settings.');
  const company = users.getCompany(r.companyId) || {};
  const base = company.baseCurrency || 'SGD';

  const date = typeof body.date === 'string' ? isoDate(body.date, { allowFuture: true }) : null;
  if (!date) fail(400, 'Say the day of the drive, as YYYY-MM-DD.');
  if (date > localDate(company.timezone || 'Asia/Singapore')) fail(400, 'The drive cannot be in the future.');
  const from = _text(body.from, 'from', 'Where the drive started');
  if (!from) fail(400, 'Say where the drive started.');
  const to = _text(body.to, 'to', 'Where the drive ended');
  if (!to) fail(400, 'Say where the drive ended.');
  const raw = typeof body.km === 'number' ? body.km : typeof body.km === 'string' && body.km.trim() ? Number(body.km) : NaN;
  const km = Number.isFinite(raw) ? Math.round(raw * 100) / 100 : NaN;
  if (!(km > 0) || km > MAX_KM) fail(400, `The distance must be a number of km above 0 and at most ${MAX_KM.toLocaleString('en-US')}.`);
  if (!TRUE.has(body.returnTrip) && !FALSE.has(body.returnTrip)) fail(400, 'Say whether it was a return trip: true or false.');
  const back = TRUE.has(body.returnTrip);
  const purpose = _text(body.purpose, 'purpose', 'The purpose');

  const total = store.toCents(km * (back ? 2 : 1) * rate) / 100;
  if (!(total > 0)) fail(400, 'That drive comes to less than a cent.');
  const kms = `${km.toLocaleString('en-US', { maximumFractionDigits: 2 })} km × ${base} ${_rate(rate)}`;
  const description = back ? `From ${from} to ${to} and back, 2 × ${kms}` : `From ${from} to ${to}, ${kms}`;
  const expense = store.createExpense({
    companyId: r.companyId, userId: r.userId, reportId: r.id, source: MILEAGE, merchant: 'Mileage', category: 'Fuel/Mileage',
    currency: base, total, receiptDate: date, description, purpose, status: 'reviewed',
    lines: [{ category: 'Fuel/Mileage', description, amount: total, currency: base }],
  });
  reports.addEvent(r.id, actor.id, 'edited', `Mileage added: ${description}`);
  await _price(expense.id);
  coverAuto.refresh(r.id);
  logger.info('Mileage added', { reportId: r.id, expenseId: expense.id, km, returnTrip: back, total, by: actor.id });
  return { report: reports.getReport(r.id), expense: store.getExpense(expense.id) };
}

module.exports = { addPerDiem, addMileage, perDiemPlan, perDiemCountry, ALLOWANCE_SOURCES, MAX_DAYS, MAX_KM };
