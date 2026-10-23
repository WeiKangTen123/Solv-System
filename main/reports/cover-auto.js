const reports = require('../store/reports');
const users   = require('../store/users');
const logger  = require('../utils/logger');
const { suggestCover } = require('./cover-suggest');
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
// No event: the history is what people did, and the cover_ai record already
// says which fields are the AI's. Never throws to its caller, which is a
// queue finishing a read or a route that has already done its work; a cover
// that could not be refreshed is logged and the next read tries again.
const DRAFT_FIELDS = ['kind', 'title', 'periodFrom', 'periodTo', 'destination', 'nights'];
const OPEN_FIELDS = ['periodFrom', 'periodTo', 'destination', 'nights'];
const WIDEN_DAYS = 3;
const ALLOWANCES = new Set(['per_diem', 'mileage']);
const _filled = v => v !== null && v !== undefined && v !== '';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const _day = d => Date.parse(`${d}T00:00:00Z`) / 86400000;

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
function _openTarget(r, s, today) {
  const dates = r.expenses
    .filter(e => !['reading', 'duplicate', 'rejected'].includes(e.status) && !ALLOWANCES.has(e.source)
      && ISO.test(String(e.receiptDate || '')) && e.receiptDate <= today)
    .map(e => e.receiptDate).sort();
  const aiOwns = f => (r.coverAi.auto || []).includes(f);
  let from = r.periodFrom, to = r.periodTo;
  if (r.kind === 'period') {
    from = _filled(from) ? from : s.periodFrom;
    to = _filled(to) ? to : s.periodTo;
  } else {
    if (!_filled(from)) from = dates[0] || null;
    if (!_filled(to)) to = dates[dates.length - 1] || null;
    if (_filled(r.periodFrom) && _filled(r.periodTo)) {
      const near = dates.filter(d => _day(d) >= _day(r.periodFrom) - WIDEN_DAYS && _day(d) <= _day(r.periodTo) + WIDEN_DAYS);
      if (aiOwns('periodFrom')) from = [r.periodFrom, ...near].sort()[0];
      if (aiOwns('periodTo')) to = [r.periodTo, ...near].sort().pop();
    }
  }
  const nights = r.kind === 'trip' && from && to ? Math.max(0, _day(to) - _day(from)) : s.nights;
  return { periodFrom: from || null, periodTo: to || null, destination: s.destination, nights: nights ?? null };
}

// Returns { changed: [fields] } when it wrote something, else null.
function refresh(reportId) {
  try {
    const r = reportId ? reports.getReport(reportId) : null;
    if (!r || (r.status !== 'draft' && r.status !== 'open')) return null;
    const company = users.getCompany(r.companyId) || {};
    const today = localDate(company.timezone || 'Asia/Singapore');
    const s = suggestCover(r.expenses, { baseCurrency: company.baseCurrency || 'SGD', today });
    // Nothing read and dated yet: nothing to say, so nothing is unsaid either.
    if (!s) return null;
    const target = r.status === 'open' ? _openTarget(r, s, today) : s;
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
    reports.applyAutoCover(r.id, patch, { auto: nextAuto, user });
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
    const ids = receiptId ? require('../db').prepare('SELECT DISTINCT report_id AS id FROM expenses WHERE receipt_id = ? AND report_id IS NOT NULL').all(receiptId).map(r => r.id) : [];
    for (const id of ids) refresh(id);
    return ids;
  } catch (err) {
    logger.warn('Case cover not refreshed after a read', { receiptId, error: err.message });
    return [];
  }
}

module.exports = { refresh, refreshForReceipt, DRAFT_FIELDS, OPEN_FIELDS, WIDEN_DAYS };
