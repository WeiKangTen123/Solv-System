const db      = require('../db');
const reports = require('../store/reports');
const users   = require('../store/users');
const logger  = require('../utils/logger');
const { suggestCover, dayRange } = require('./cover-suggest');
const { localDate } = require('../utils/zone-date');

// The AI keeping a case's cover up with its receipts, called each time a read
// lands in it (read-queue's setOnDone) and when receipts move in or out.
//
//   draft    every cover field the owner has not set: it is the AI's draft
//            until they say otherwise.
//   open     only the dates, the destination and the nights. The owner chose
//            the kind and the title when they created it. The dates take in
//            a receipt that lands just beside them (a folio read after
//            Create, the taxi home the next morning), up to WIDEN_DAYS either
//            side, and nothing further: a receipt weeks away is flagged as
//            outside the case instead. Stretching to fit everything turned a
//            reopened four-day trip into seven weeks, which every local
//            receipt then "fitted". A month never widens.
//   claimed  nothing. What was claimed stays as it was claimed.
//
// A field the owner set (cover_ai.user) is never written. On an open case a
// field that already holds something the AI did not write is left alone too:
// a case from before the AI kept track has nothing in `user`, and its dates
// were typed by somebody all the same.
//
// Every refresh that changes a value says so in the case's history, as one
// `ai_details` event naming each field old → new. The case's Activity is
// where the person finds out why the dates moved under them; a refresh that
// only re-marks a field changes nothing anybody sees, and writes nothing.
//
// Never throws to its caller, which is a queue finishing a read or a route
// that has already done its work; a cover that could not be refreshed is
// logged and the next read tries again.
const DRAFT_FIELDS = ['kind', 'title', 'periodFrom', 'periodTo', 'destination', 'nights'];
const OPEN_FIELDS = ['periodFrom', 'periodTo', 'destination', 'nights'];
const WIDEN_DAYS = 3;
const ALLOWANCES = new Set(['per_diem', 'mileage']);
const _filled = v => v !== null && v !== undefined && v !== '';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const _day = d => Date.parse(`${d}T00:00:00Z`) / 86400000;
const _lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// The receipt days that say when a case was: read, not a duplicate, not a per
// diem or mileage row (cover-suggest.js), and not after today.
function _dates(r, today) {
  return (r.expenses || [])
    .filter(e => !['reading', 'duplicate', 'rejected'].includes(e.status) && !ALLOWANCES.has(e.source)
      && ISO.test(String(e.receiptDate || '')) && (!today || e.receiptDate <= today))
    .map(e => e.receiptDate).sort();
}

// The calendar month holding most of the receipts (the earliest on a tie):
// a Month is one month, and receipts from either side of it are flagged as
// outside it rather than stretching it into two.
function _busiestMonth(dates) {
  const n = new Map();
  for (const d of dates) n.set(d.slice(0, 7), (n.get(d.slice(0, 7)) || 0) + 1);
  let best = null;
  for (const [ym, c] of n) if (!best || c > best.c) best = { ym, c };
  if (!best) return null;
  const y = Number(best.ym.slice(0, 4)), m = Number(best.ym.slice(5, 7));
  return { periodFrom: `${best.ym}-01`, periodTo: `${best.ym}-${String(_lastDay(y, m)).padStart(2, '0')}` };
}

// What an open case's own fields should become: its dates widened only to
// receipts beside them, and the nights counted from those dates rather than
// from every receipt the suggestion saw.
//
// Only an end the AI wrote widens: an end the person typed stays where they
// put it, and the nights are counted from the dates the case really has (a
// receipt the day after a typed 1-4 Sep made it "4 nights"). Empty ends of a
// trip or a job take the receipts' own first and last day, not the whole
// month a suggestion would make of them; only a Month fills as a month.
// Per diem and mileage rows are not evidence of dates (cover-suggest.js).
//
// Where it was is said by the receipts inside those dates: a stray receipt
// from weeks later is flagged outside the case, and named its destination too.
//
// `asIfAi` asks what the AI would make of every field were it the AI's: the
// "Fill from receipts" panel (cover-help.js) shows that beside what the case
// has, and handing a field back (routes/cover.js) gives exactly that value.
// `within` is the suggestion of the receipts inside the dates, and `inside`
// those receipts, for the title and the source line made from them.
function openTarget(r, s, { today, baseCurrency = 'SGD', asIfAi = false } = {}) {
  const dates = _dates(r, today);
  const aiOwns = f => asIfAi || ((r.coverAi && r.coverAi.auto) || []).includes(f);
  let from = r.periodFrom, to = r.periodTo;
  if (r.kind === 'period') {
    const m = _busiestMonth(dates);
    if (!_filled(from)) from = m ? m.periodFrom : null;
    if (!_filled(to)) to = m ? m.periodTo : null;
  } else {
    if (!_filled(from)) from = dates[0] || null;
    if (!_filled(to)) to = dates[dates.length - 1] || null;
    if (_filled(r.periodFrom) && _filled(r.periodTo)) {
      const near = dates.filter(d => _day(d) >= _day(r.periodFrom) - WIDEN_DAYS && _day(d) <= _day(r.periodTo) + WIDEN_DAYS);
      if (aiOwns('periodFrom')) from = [r.periodFrom, ...near].sort()[0];
      if (aiOwns('periodTo')) to = [r.periodTo, ...near].sort().pop();
    }
  }
  const lo = from && to && from > to ? to : from, hi = from && to && from > to ? from : to;
  const inside = lo && hi ? (r.expenses || []).filter(e => ISO.test(String(e.receiptDate || '')) && e.receiptDate >= lo && e.receiptDate <= hi) : (r.expenses || []);
  const within = (inside.length && suggestCover(inside, { baseCurrency, today })) || s;
  const nights = r.kind === 'trip' && from && to ? Math.max(0, _day(to) - _day(from)) : (within ? within.nights : null);
  return { periodFrom: from || null, periodTo: to || null, destination: within ? within.destination : null, nights: nights ?? null,
           within, inside: within === s ? (r.expenses || []) : inside };
}

// "Dates 1–4 Sep 2026 → 31 Aug – 4 Sep 2026; nights 3 → 4": what one refresh
// changed, in the words the case page uses, for the case's Activity. The
// assistant's details card (assistant/tools.js) says its change the same way,
// purpose and notes included, which the AI never writes itself.
const KIND_WORD = { trip: 'Trip', period: 'Month', case: 'Other' };
const NOTE_SHOWN = 80;
const _text = v => (_filled(v) ? `“${String(v).length > NOTE_SHOWN ? `${String(v).slice(0, NOTE_SHOWN - 1)}…` : v}”` : 'empty');
function _range(from, to) {
  if (from && to) return from <= to ? dayRange(from, to) : dayRange(to, from);
  if (from) return `from ${dayRange(from, from)}`;
  if (to) return `until ${dayRange(to, to)}`;
  return 'empty';
}
function changeNote(before, patch) {
  const was = f => (before[f] === undefined ? null : before[f]);
  const now = f => (patch[f] !== undefined ? patch[f] : was(f));
  const parts = [];
  if ('kind' in patch) parts.push(`kind ${KIND_WORD[was('kind')] || 'empty'} → ${KIND_WORD[now('kind')] || 'empty'}`);
  if ('title' in patch) parts.push(`title ${_text(was('title'))} → ${_text(now('title'))}`);
  if ('periodFrom' in patch || 'periodTo' in patch) parts.push(`dates ${_range(was('periodFrom'), was('periodTo'))} → ${_range(now('periodFrom'), now('periodTo'))}`);
  if ('destination' in patch) parts.push(`destination ${_text(was('destination'))} → ${_text(now('destination'))}`);
  if ('nights' in patch) parts.push(`nights ${_filled(was('nights')) ? was('nights') : 'empty'} → ${_filled(now('nights')) ? now('nights') : 'empty'}`);
  for (const f of ['purpose', 'notes']) if (f in patch) parts.push(`${f} ${_text(was(f))} → ${_text(now(f))}`);
  const note = parts.join('; ');
  return note ? note[0].toUpperCase() + note.slice(1) : null;
}

// Returns { changed: [fields] } when it wrote something, else null.
function refresh(reportId) {
  try {
    const r = reportId ? reports.getReport(reportId) : null;
    if (!r || (r.status !== 'draft' && r.status !== 'open')) return null;
    const company = users.getCompany(r.companyId) || {};
    const today = localDate(company.timezone || 'Asia/Singapore');
    const baseCurrency = company.baseCurrency || 'SGD';
    const s = suggestCover(r.expenses, { baseCurrency, today });
    // Nothing read and dated yet: nothing to say, so nothing is unsaid either.
    if (!s) return null;
    const target = r.status === 'open' ? openTarget(r, s, { today, baseCurrency }) : s;
    const { auto, user } = r.coverAi;
    const patch = {};
    let nextAuto = auto.filter(f => !user.includes(f));
    for (const f of r.status === 'draft' ? DRAFT_FIELDS : OPEN_FIELDS) {
      if (user.includes(f)) continue;
      if (r.status === 'open' && _filled(r[f]) && !auto.includes(f)) continue;
      const v = _filled(target[f]) ? target[f] : null;
      if ((r[f] ?? null) !== v) patch[f] = v;
      // A field the AI emptied is nobody's again, and carries no marker.
      nextAuto = nextAuto.filter(x => x !== f);
      if (v !== null) nextAuto.push(f);
    }
    const sameAuto = nextAuto.length === auto.length && nextAuto.every(f => auto.includes(f));
    if (!Object.keys(patch).length && sameAuto) return null;
    // The cover and the line in its history together: a history that says
    // the dates moved when they did not, or the other way round, is worse
    // than none.
    db.transaction(() => {
      reports.applyAutoCover(r.id, patch, { auto: nextAuto, user });
      if (Object.keys(patch).length) reports.addEvent(r.id, null, 'ai_details', changeNote(r, patch));
    })();
    return { changed: Object.keys(patch) };
  } catch (err) {
    logger.warn('Could not refresh a case cover from its receipts', { reportId, error: err.message });
    return null;
  }
}

// After a read: every case the file's receipts sit in. Usually one; a file
// split into several receipts can have had one moved elsewhere while the rest
// were still being read.
function refreshForReceipt(receiptId) {
  try {
    const ids = receiptId ? db.prepare('SELECT DISTINCT report_id AS id FROM expenses WHERE receipt_id = ? AND report_id IS NOT NULL').all(receiptId).map(r => r.id) : [];
    for (const id of ids) refresh(id);
    return ids;
  } catch (err) {
    logger.warn('Case cover not refreshed after a read', { receiptId, error: err.message });
    return [];
  }
}

module.exports = { refresh, refreshForReceipt, openTarget, changeNote, DRAFT_FIELDS, OPEN_FIELDS, WIDEN_DAYS, KIND_WORD };
