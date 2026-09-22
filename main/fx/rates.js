const db = require('../db');
const providers = require('./providers');
const logger = require('../utils/logger');

// The rate for one unit of `from` in `to`, for a date. Cached for good once
// known — a historical reference rate never changes — except today's, which
// providers update through the day and which is re-fetched after an hour.
//
// Priority when several rows exist for a day: a rate finance typed in, then
// the ECB reference rate, then the daily open.er-api rate.
const PRIORITY = { manual: 0, frankfurter: 1, 'open.er-api': 2 };
const TODAY_TTL_MS = 60 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);

// Two checks on every rate the providers hand over, because nothing else looks
// at them and a wrong rate is frozen onto a line and paid.
//
//   divergence  the two providers priced the same day differently. They
//               normally sit within a few tenths of a percent of each other, so
//               a whole percent means one of them is wrong or stale. Noted on
//               the rate and shown, but not blocking: we take the ECB's.
//   moved       this rate is a long way from the last one we knew for the pair.
//               A currency can genuinely move, but not usually by a tenth in a
//               day, so this one does block: the line is left without a rate
//               and says why, and finance types the rate in to settle it.
const DIVERGENCE_FLAG = 0.01;
// A tenth in a day is the bar, and it grows with the gap: a rate ten days older
// is a weaker comparison, and judging it by the same tenth refused legitimate
// moves. Sterling fell about 9% in the month to 26 Sep 2022 with nothing wrong,
// and the lira moved 25% in one day, so the ceiling stays well clear of both.
const MAX_MOVE = 0.10;
const MOVE_CEILING = 0.30;
const MOVE_WINDOW_DAYS = 10;
const allowedMove = days => Math.min(MOVE_CEILING, MAX_MOVE * Math.sqrt(Math.max(1, days)));

function _row(r) {
  if (!r) return null;
  const row = { from: r.base, to: r.quote, rateDate: r.rate_date, rate: r.rate, source: r.source, fetchedAt: r.fetched_at,
    providerDate: r.provider_date || r.rate_date, enteredBy: r.entered_by || null,
    divergence: r.divergence ?? null, moved: r.moved ?? null };
  row.notes = [];
  if (row.source !== 'manual') {
    if (row.divergence !== null && Math.abs(row.divergence) > DIVERGENCE_FLAG) {
      row.notes.push(`the two rate providers disagree by ${(Math.abs(row.divergence) * 100).toFixed(2)}% on this day`);
    }
    if (row.moved !== null && Math.abs(row.moved) > allowedMove(row.movedOverDays ?? 1)) {
      row.blocked = `${row.from} moved ${(row.moved * 100).toFixed(1)}% against ${row.to} since the last rate we had. Check it, then enter the rate to use.`;
      row.notes.push(row.blocked);
    }
  }
  return row;
}

// How far this rate is from the last one known for the pair.
//
// Three things it deliberately does not compare against. A rate somebody typed
// in, because that is a human decision and a typo in it would block every real
// rate after it. A rate this check itself rejected — those are no longer stored
// at all, see _fetch. And a row whose real pricing day is far from this one:
// the comparison is made on provider_date, not on the date the row is filed
// under, because for the currencies with no published history every row is
// filed under its receipt's date while holding the rate of the day it was
// fetched, and two rows six days apart on paper can be months apart in fact.
function _movement(from, to, pricedOn, rate) {
  const prev = db.prepare(`SELECT rate, COALESCE(provider_date, rate_date) AS priced FROM fx_rates
                           WHERE base = ? AND quote = ? AND rate > 0 AND source != 'manual'
                             AND COALESCE(provider_date, rate_date) < ?
                           ORDER BY priced DESC LIMIT 1`).get(from, to, pricedOn);
  if (!prev) return null;
  const days = (Date.parse(pricedOn) - Date.parse(prev.priced)) / 86400000;
  if (!(days >= 0) || days > MOVE_WINDOW_DAYS) return null;
  return { moved: (rate - prev.rate) / prev.rate, days, against: prev.rate, on: prev.priced };
}

function _cached(from, to, date) {
  const rows = db.prepare('SELECT * FROM fx_rates WHERE base = ? AND quote = ? AND rate_date = ?').all(from, to, date).map(_row);
  rows.sort((a, b) => (PRIORITY[a.source] ?? 9) - (PRIORITY[b.source] ?? 9));
  return rows[0] || null;
}

function _save({ from, to, date, rate, source, providerDate, by = null, divergence = null, moved = null }) {
  db.prepare(`INSERT INTO fx_rates (base, quote, rate_date, rate, source, fetched_at, provider_date, entered_by, divergence, moved)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(base, quote, rate_date, source) DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at,
                provider_date = excluded.provider_date, entered_by = excluded.entered_by, divergence = excluded.divergence, moved = excluded.moved`)
    .run(from, to, date, rate, source, new Date().toISOString(), providerDate || date, by, divergence, moved);
  return _cached(from, to, date);
}

async function _fetch(from, to, date) {
  const historical = date < today() ? date : null;      // today or later: latest
  const f = await providers.frankfurter(from, to, historical);
  // The second provider is asked as a check when it can answer for the same
  // day, and as the fallback when the first cannot answer at all. It only ever
  // knows today, so comparing it against a historical rate would be comparing
  // two different days.
  const alt = (!f || !historical) ? await providers.erapi(from, to) : null;
  const chosen = f || alt;
  if (!chosen) {
    logger.warn('No exchange rate from any provider', { from, to, date });
    return null;
  }
  const divergence = f && alt ? (f.rate - alt.rate) / alt.rate : null;
  const m = _movement(from, to, chosen.providerDate || date, chosen.rate);
  if (divergence !== null && Math.abs(divergence) > DIVERGENCE_FLAG) {
    logger.warn('Rate providers disagree', { from, to, date, frankfurter: f.rate, erapi: alt.rate, divergence });
  }
  // A rate this check rejects is NOT stored. Storing it made the block
  // permanent — a historical row never expires, so the refused rate came back
  // from the cache for ever — and made the glitch the baseline the next day,
  // so one bad morning from a provider refused two days of correct rates.
  // Nothing cached means the next look asks the provider again.
  if (m && Math.abs(m.moved) > allowedMove(m.days)) {
    logger.warn('Rate moved further than expected; not stored', { from, to, date, rate: chosen.rate, moved: m.moved, days: m.days, against: m.against });
    return {
      from, to, rateDate: date, rate: chosen.rate, source: chosen.source, providerDate: chosen.providerDate,
      fetchedAt: new Date().toISOString(), divergence, moved: m.moved, movedOverDays: m.days, notes: [],
      blocked: `${from} moved ${(m.moved * 100).toFixed(1)}% against ${to} since the rate of ${m.on}. Check it, then enter the rate to use.`,
    };
  }
  return _save({ from, to, date, rate: chosen.rate, source: chosen.source, providerDate: chosen.providerDate, divergence, moved: m ? m.moved : null });
}

async function getRate({ from, to, date, force = false }) {
  if (!from || !to) return null;
  if (from === to) return { from, to, rateDate: date, rate: 1, source: 'same', fetchedAt: new Date().toISOString(), providerDate: date };
  const day = date || today();
  const hit = _cached(from, to, day);
  if (hit && hit.source === 'manual') return hit;          // a decision, never re-fetched over
  if (hit && !force) {
    const stale = hit.source !== 'manual' && day >= today() && Date.now() - Date.parse(hit.fetchedAt) > TODAY_TTL_MS;
    if (!stale) return hit;
  }
  const fresh = await _fetch(from, to, day);
  return fresh || hit || null;
}

function setManualRate({ from, to, date, rate, by }) {
  if (!(Number(rate) > 0)) throw new Error('A rate must be a number above zero');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('Date must be YYYY-MM-DD');
  if (!/^[A-Z]{3}$/.test(String(from || '').toUpperCase()) || !/^[A-Z]{3}$/.test(String(to || '').toUpperCase())) throw new Error('Currencies must be 3-letter codes');
  return _save({ from: String(from).toUpperCase(), to: String(to).toUpperCase(), date, rate: Number(rate), source: 'manual', providerDate: date, by });
}

function deleteManualRate({ from, to, date }) {
  return db.prepare("DELETE FROM fx_rates WHERE base = ? AND quote = ? AND rate_date = ? AND source = 'manual'").run(from, to, date).changes > 0;
}

function listRates({ to, from, since } = {}) {
  const where = [], args = [];
  if (to)    { where.push('quote = ?'); args.push(to); }
  if (from)  { where.push('base = ?'); args.push(from); }
  if (since) { where.push('rate_date >= ?'); args.push(since); }
  return db.prepare(`SELECT * FROM fx_rates ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY rate_date DESC, base, source LIMIT 500`).all(...args).map(_row);
}

module.exports = { getRate, setManualRate, deleteManualRate, listRates, TODAY_TTL_MS, PRIORITY, DIVERGENCE_FLAG, MAX_MOVE, MOVE_CEILING, MOVE_WINDOW_DAYS, allowedMove };
