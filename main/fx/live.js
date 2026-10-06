const db        = require('../db');
const providers = require('./providers');
const rates     = require('./rates');
const users     = require('../store/users');
const logger    = require('../utils/logger');
const { CURRENCIES } = require('../intake/currencies');

// The live board, and the daily close that turns it into a log.
//
// Through the day every watched currency is refreshed on a schedule and the
// latest figure kept in fx_live. At 23:55 company time the day's last figure
// is written into fx_rates as that day's close — the price of the day for
// every receipt dated it. A receipt dated today is priced at the live figure
// meanwhile, and moved to the close that night unless its case was claimed.
//
// Where the figure comes from, in order:
//   Open Exchange Rates  when an admin has added an App ID — the one feed
//                        here that moves within the day (hourly on its free
//                        plan, faster on paid ones)
//   European Central Bank through Frankfurter — 30 currencies, published once
//                        each working day around 16:00 CET
//   ExchangeRate-API     the open endpoint — about 160 currencies, refreshed
//                        once a day
// Without a key the board is honest about that: the figure is the latest
// published, and the page says when it was published.

// How often the board refreshes. An hour suits every source: the free feeds
// publish daily, and Open Exchange Rates' free plan updates hourly within
// 1,000 requests a month — 24 a day is 744. A paid plan can go faster.
const EVERY_MIN = Math.max(5, Number(process.env.FX_LIVE_MINUTES) || 60);
const CLOSE_AT  = '23:55';
const CLOSE_AT_MIN = 23 * 60 + 55;
const TICK_MS   = 60 * 1000;
// An admin's Refresh button, at most this often, so it cannot spend a paid
// feed's monthly allowance in an afternoon of clicking.
const MANUAL_GAP_MS = 60 * 1000;

const SOURCE_LABEL = {
  openexchangerates: 'Open Exchange Rates',
  frankfurter: 'European Central Bank',
  'open.er-api': 'ExchangeRate-API',
  manual: 'Set by an admin',
};
const NAMES = new Map(CURRENCIES.map(c => [c.code, c.name]));
const CODE = /^[A-Z]{3}$/;

// ── Company time ────────────────────────────────────────────────────────────
// The day closes where the company is, not in UTC: Singapore's 23:55 is
// 15:55 UTC, and a close taken on UTC's midnight would file eight hours of
// the next morning under the previous day.
const { localDate, localMinutes, addDays } = require('../utils/zone-date');

// ── What is watched ─────────────────────────────────────────────────────────
// Every currency a receipt in the company has used, and any an admin asked to
// watch ahead of one. Busiest first.
function watched(companyId) {
  const company = users.getCompany(companyId);
  if (!company) return [];
  const base = company.baseCurrency;
  const used = db.prepare(`SELECT currency, COUNT(*) AS n FROM expenses
                           WHERE company_id = ? AND currency IS NOT NULL AND currency != ? AND status NOT IN ('duplicate', 'rejected')
                           GROUP BY currency`).all(companyId, base);
  const pinned = db.prepare('SELECT currency, added_by, added_at FROM fx_watch WHERE company_id = ?').all(companyId);
  const out = new Map();
  for (const u of used) if (CODE.test(u.currency)) out.set(u.currency, { currency: u.currency, receipts: u.n, pinned: false });
  for (const p of pinned) {
    if (!CODE.test(p.currency) || p.currency === base) continue;
    const row = out.get(p.currency) || { currency: p.currency, receipts: 0 };
    out.set(p.currency, { ...row, pinned: true, addedBy: p.added_by, addedAt: p.added_at });
  }
  return [...out.values()].sort((a, b) => b.receipts - a.receipts || a.currency.localeCompare(b.currency));
}

function watch(companyId, currency, by = null) {
  const company = users.getCompany(companyId);
  const ccy = String(currency || '').trim().toUpperCase();
  if (!CODE.test(ccy)) throw new Error('Currency must be a 3-letter code like INR or MYR');
  if (ccy === company.baseCurrency) throw new Error(`${ccy} is the company's own currency`);
  db.prepare('INSERT OR IGNORE INTO fx_watch (company_id, currency, added_by, added_at) VALUES (?, ?, ?, ?)')
    .run(companyId, ccy, by, new Date().toISOString());
  return ccy;
}

// Only what an admin pinned can be unpinned. A currency receipts use stays on
// the board for as long as they use it.
function unwatch(companyId, currency) {
  return db.prepare('DELETE FROM fx_watch WHERE company_id = ? AND currency = ?').run(companyId, String(currency || '').toUpperCase()).changes > 0;
}

// ── Where the figure comes from ─────────────────────────────────────────────
function _appId(companyId) { return users.getCompanyConfig(companyId).FX_OXR_APP_ID || null; }

function sourceInfo(companyId) {
  const appId = _appId(companyId);
  return {
    keyed: !!appId,
    provider: appId ? 'openexchangerates' : 'frankfurter',
    label: appId ? 'Open Exchange Rates' : 'European Central Bank, then ExchangeRate-API',
    keyMasked: appId ? `••••${appId.slice(-4)}` : null,
    everyMinutes: EVERY_MIN,
  };
}

// Checked before it is kept: a mistyped App ID would otherwise sit there
// quietly while the board went on showing the daily figures.
async function setOxrKey(companyId, appId) {
  const key = String(appId || '').trim();
  if (!key) {
    users.saveCompanyConfig(companyId, { FX_OXR_APP_ID: '' });
    return sourceInfo(companyId);
  }
  const table = await providers.oxrAll(key);
  const base = users.getCompany(companyId).baseCurrency;
  if (!providers.crossRate(table, 'USD', base)) throw new Error(`Open Exchange Rates does not price ${base}`);
  users.saveCompanyConfig(companyId, { FX_OXR_APP_ID: key });
  return sourceInfo(companyId);
}

// ── Refresh ─────────────────────────────────────────────────────────────────
const _lastRefresh = new Map();   // companyId -> ms

// One request per source, whatever the number of currencies: each returns its
// whole table against the base, and crossRate() reads the pairs out of it.
async function refresh(companyId, { manual = false } = {}) {
  const company = users.getCompany(companyId);
  if (!company) return null;
  const last = _lastRefresh.get(companyId) || 0;
  if (manual && Date.now() - last < MANUAL_GAP_MS) return { throttled: true, retryInMs: MANUAL_GAP_MS - (Date.now() - last) };
  _lastRefresh.set(companyId, Date.now());

  const base = company.baseCurrency;
  const list = watched(companyId);
  if (!list.length) return { refreshed: 0, missing: [], source: null };

  const appId = _appId(companyId);
  let oxr = null, oxrError = null;
  if (appId) {
    try { oxr = await providers.oxrAll(appId); }
    catch (err) { oxrError = err.message; logger.warn('Open Exchange Rates refresh failed; using the daily feeds', { companyId, error: err.message }); }
  }
  const [ecb, er] = await Promise.all([providers.frankfurterAll(base), providers.erapiAll(base)]);
  const tables = [oxr, ecb, er].filter(Boolean);

  const at = new Date().toISOString();
  const upsert = db.prepare(`INSERT INTO fx_live (base, quote, rate, source, provider_date, provider_time, fetched_at, divergence)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                             ON CONFLICT(base, quote) DO UPDATE SET rate = excluded.rate, source = excluded.source,
                               provider_date = excluded.provider_date, provider_time = excluded.provider_time,
                               fetched_at = excluded.fetched_at, divergence = excluded.divergence`);
  const missing = [];
  db.transaction(() => {
    for (const w of list) {
      const found = tables.map(t => ({ t, rate: providers.crossRate(t, w.currency, base) })).filter(x => x.rate > 0);
      if (!found.length) { missing.push(w.currency); continue; }
      // The first source that prices it is the figure; the next one is the
      // check, kept as a divergence the board and the close both carry.
      const [chosen, other] = found;
      const divergence = other ? (chosen.rate - other.rate) / other.rate : null;
      upsert.run(w.currency, base, chosen.rate, chosen.t.source, chosen.t.providerDate, chosen.t.providerTime, at, divergence);
    }
  })();
  if (missing.length) logger.warn('No live rate for some watched currencies', { companyId, missing });
  return { refreshed: list.length - missing.length, missing, source: tables[0] ? tables[0].source : null, oxrError, at };
}

// ── The daily close ─────────────────────────────────────────────────────────
function closedOn(companyId, date) {
  return !!db.prepare('SELECT 1 FROM fx_closes WHERE company_id = ? AND close_date = ?').get(companyId, date);
}

// Writes the day's close for every watched currency. Taken on the day, it is
// the last live figure, refreshed a moment before. Taken late — the server was
// not running at 23:55 — it is whatever the providers say about that day: the
// ECB publishes history, so most currencies close at their real rate; the rest
// close at the latest figure and the receipt says it was not priced on the day.
async function close(companyId, date, { now = new Date() } = {}) {
  const company = users.getCompany(companyId);
  if (!company) return null;
  const tz = company.timezone, base = company.baseCurrency;
  if (date === localDate(tz, now)) await refresh(companyId);

  const out = { date, closed: [], blocked: [], missing: [] };
  for (const w of watched(companyId)) {
    const live = rates.liveRate(w.currency, base);
    let r;
    if (live && localDate(tz, new Date(live.fetchedAt)) === date) {
      r = rates.recordClose({ from: w.currency, to: base, date, rate: live.rate, source: live.source, providerDate: live.providerDate, divergence: live.divergence });
    } else {
      const found = await rates.getRate({ from: w.currency, to: base, date, today: localDate(tz, now) });
      r = found && !found.blocked && found.source !== 'manual' && !found.closedAt
        ? rates.markClosed({ from: w.currency, to: base, date, source: found.source })
        : found;
    }
    if (!r) out.missing.push(w.currency);
    else if (r.blocked) out.blocked.push({ currency: w.currency, why: r.blocked });
    else out.closed.push(w.currency);
  }
  db.prepare('INSERT OR REPLACE INTO fx_closes (company_id, close_date, closed_at, summary) VALUES (?, ?, ?, ?)')
    .run(companyId, date, new Date().toISOString(), JSON.stringify(out));
  out.repriced = await repriceDay(companyId, date);
  logger.info('Exchange rates closed for the day', { companyId, date, closed: out.closed.length, blocked: out.blocked.length, missing: out.missing, repriced: out.repriced });
  return out;
}

// A currency that joins the board mid-day has nothing to compare against until
// tonight's close. Yesterday's rate from the providers' history stands in as
// its last close, so the board shows a move from the first day. One request,
// and nothing when a close or any earlier rate is already there.
async function backfill(companyId, currency, { now = new Date() } = {}) {
  const company = users.getCompany(companyId);
  if (!company) return null;
  const tz = company.timezone, base = company.baseCurrency;
  const day = localDate(tz, now);
  if (rates.lastClose(currency, base, day)) return null;
  const yesterday = addDays(day, -1);
  const found = await rates.getRate({ from: currency, to: base, date: yesterday, today: day });
  if (found && !found.blocked && found.source !== 'manual' && !found.closedAt) {
    return rates.markClosed({ from: currency, to: base, date: yesterday, source: found.source });
  }
  return found;
}

// Receipts priced during the day at the live figure move to the close. Only
// those still open: a claimed receipt keeps the rate it was claimed at, a
// rate somebody typed is theirs, and a duplicate is nobody's.
async function repriceDay(companyId, date) {
  const ids = db.prepare(`SELECT DISTINCT e.id FROM expenses e
                          JOIN expense_lines l ON l.expense_id = e.id
                          LEFT JOIN expense_reports r ON r.id = e.report_id
                          WHERE e.company_id = ? AND l.fx_asked_date = ?
                            AND l.fx_override_by IS NULL AND COALESCE(l.fx_source, '') NOT IN ('base', 'manual', 'same')
                            AND e.status NOT IN ('duplicate', 'rejected') AND e.claimed_at IS NULL
                            AND (e.report_id IS NULL OR r.status = 'open')`).all(companyId, date).map(r => r.id);
  return _reprice(ids);
}

// An admin set, corrected or removed the rate for one currency on one day.
// Every open receipt priced for that day follows it, except those somebody
// typed a rate onto for that receipt alone. A typo in a monthly rate used to
// stay on every receipt until each claimant pressed Refresh.
async function repriceRate(companyId, currency, date) {
  const ids = db.prepare(`SELECT DISTINCT e.id FROM expenses e
                          JOIN expense_lines l ON l.expense_id = e.id
                          LEFT JOIN expense_reports r ON r.id = e.report_id
                          WHERE e.company_id = ? AND e.currency = ? AND l.fx_asked_date = ?
                            AND l.fx_override_by IS NULL AND COALESCE(l.fx_source, '') NOT IN ('base', 'same')
                            AND e.status NOT IN ('duplicate', 'rejected') AND e.claimed_at IS NULL
                            AND (e.report_id IS NULL OR r.status = 'open')`).all(companyId, currency, date).map(r => r.id);
  return _reprice(ids);
}

async function _reprice(ids) {
  const store = require('../store/expenses');
  const { applyFx } = require('./apply');
  let changed = 0;
  for (const id of ids) {
    const before = store.getExpense(id);
    try { await applyFx(id); }
    catch (err) { logger.warn('Re-pricing to the close failed', { expenseId: id, error: err.message }); continue; }
    const after = store.getExpense(id);
    if (after && before && after.baseTotal !== before.baseTotal) changed++;
  }
  return { looked: ids.length, changed };
}

// ── The schedule ────────────────────────────────────────────────────────────
let _timer = null, _running = false;

// Once a minute: take yesterday's close if it was missed, take today's at
// 23:55, and otherwise refresh when the interval is up.
async function tick(now = new Date()) {
  if (_running) return { skipped: true };
  _running = true;
  const done = [];
  try {
    for (const { id } of db.prepare('SELECT id FROM companies').all()) {
      try {
        const tz = users.getCompany(id).timezone || 'Asia/Singapore';
        const day = localDate(tz, now);
        const yesterday = addDays(day, -1);
        // Every day since the last close, a week at most: after a weekend of
        // downtime only Sunday used to be closed, and Friday's and Saturday's
        // receipts kept a provisional figure for good. With no close yet at
        // all, yesterday alone.
        const last = db.prepare('SELECT MAX(close_date) AS d FROM fx_closes WHERE company_id = ?').get(id).d;
        const weekAgo = addDays(day, -7);
        for (let d = last && last < yesterday ? addDays(last, 1) : yesterday; d <= yesterday; d = addDays(d, 1)) {
          if (d >= weekAgo && !closedOn(id, d)) done.push(await close(id, d, { now }));
        }
        if (localMinutes(tz, now) >= CLOSE_AT_MIN && !closedOn(id, day)) { done.push(await close(id, day, { now })); continue; }
        if (Date.now() - (_lastRefresh.get(id) || 0) >= EVERY_MIN * 60 * 1000) await refresh(id);
      } catch (err) {
        logger.warn('Live exchange-rate tick failed', { companyId: id, error: err.message });
      }
    }
  } finally {
    _running = false;
  }
  return done;
}

function start({ everyMs = TICK_MS } = {}) {
  if (_timer) return _timer;
  _timer = setInterval(() => { tick().catch(err => logger.warn('Live exchange rates failed', { error: err.message })); }, everyMs);
  if (typeof _timer.unref === 'function') _timer.unref();
  // The first look shortly after boot, not a whole minute in: a restart at
  // 23:56 must still close the day.
  const first = setTimeout(() => { tick().catch(() => {}); }, 5000);
  if (typeof first.unref === 'function') first.unref();
  logger.info('Live exchange rates started', { refreshMinutes: EVERY_MIN, closeAt: CLOSE_AT });
  return _timer;
}
function stop() { if (_timer) clearInterval(_timer); _timer = null; }

// ── What the page shows ─────────────────────────────────────────────────────
function board(companyId, { now = new Date() } = {}) {
  const company = users.getCompany(companyId);
  const base = company.baseCurrency, tz = company.timezone;
  const day = localDate(tz, now);
  const manualToday = db.prepare("SELECT base, rate, entered_by FROM fx_rates WHERE quote = ? AND rate_date = ? AND source = 'manual'").all(base, day);
  const manualBy = new Map(manualToday.map(m => [m.base, m]));
  let updatedAt = null;
  const rows = watched(companyId).map(w => {
    const live = rates.liveRate(w.currency, base);
    const prev = rates.lastClose(w.currency, base, day);
    if (live && (!updatedAt || live.fetchedAt > updatedAt)) updatedAt = live.fetchedAt;
    const m = manualBy.get(w.currency);
    return {
      currency: w.currency, name: NAMES.get(w.currency) || null, receipts: w.receipts, pinned: !!w.pinned,
      live: live ? { rate: live.rate, source: live.source, sourceLabel: SOURCE_LABEL[live.source] || live.source,
                     providerDate: live.providerDate, providerTime: live.providerTime, fetchedAt: live.fetchedAt, divergence: live.divergence } : null,
      // Small rates read badly — 0.0132952 — so the other direction rides
      // along: 1 SGD = 75.22 INR is how people actually say it.
      inverse: live && live.rate > 0 ? 1 / live.rate : null,
      lastClose: prev ? { date: prev.rateDate, rate: prev.rate, source: prev.source, closed: !!prev.closedAt } : null,
      change: live && prev && prev.rate > 0 ? (live.rate - prev.rate) / prev.rate : null,
      manualToday: m ? { rate: m.rate, by: m.entered_by } : null,
    };
  });
  return {
    base, timezone: tz, today: day, closesAt: CLOSE_AT, closedToday: closedOn(companyId, day),
    source: sourceInfo(companyId), updatedAt, rows,
  };
}

// The daily log for one currency, newest first. Before the close, today's
// line is the live figure.
function log(companyId, currency, { limit = 60, now = new Date() } = {}) {
  const company = users.getCompany(companyId);
  const base = company.baseCurrency, tz = company.timezone;
  const day = localDate(tz, now);
  const used = new Map(db.prepare(`SELECT l.fx_asked_date AS d, COUNT(DISTINCT e.id) AS n FROM expense_lines l
                                   JOIN expenses e ON e.id = l.expense_id
                                   WHERE e.company_id = ? AND l.currency = ? AND e.status NOT IN ('duplicate', 'rejected')
                                   GROUP BY l.fx_asked_date`).all(companyId, currency).map(r => [r.d, r.n]));
  const entries = rates.history(currency, base, { limit }).map(e => ({
    date: e.date, rate: e.rate, source: e.source, sourceLabel: SOURCE_LABEL[e.source] || e.source,
    kind: e.source === 'manual' ? 'manual' : e.closedAt ? 'close' : 'lookup',
    providerDate: e.providerDate, enteredBy: e.enteredBy, overrides: e.overrides, notes: e.notes, usedBy: used.get(e.date) || 0,
  }));
  const live = rates.liveRate(currency, base);
  if (live && !closedOn(companyId, day)) {
    const i = entries.findIndex(e => e.date === day);
    const liveEntry = { date: day, rate: live.rate, source: live.source, sourceLabel: SOURCE_LABEL[live.source] || live.source, kind: 'live',
                        providerDate: live.providerDate, fetchedAt: live.fetchedAt, usedBy: used.get(day) || 0, overrides: null, notes: [] };
    if (i === -1) entries.unshift(liveEntry);
    else if (entries[i].kind !== 'manual') entries[i] = liveEntry;   // an admin's rate for today still shows as theirs
  }
  return { currency, name: NAMES.get(currency) || null, base, today: day, closesAt: CLOSE_AT, entries };
}

module.exports = {
  watched, watch, unwatch, refresh, close, backfill, repriceDay, repriceRate, tick, start, stop, board, log, sourceInfo, setOxrKey, closedOn,
  localDate, localMinutes, addDays, EVERY_MIN, CLOSE_AT, SOURCE_LABEL, _lastRefresh,
};
