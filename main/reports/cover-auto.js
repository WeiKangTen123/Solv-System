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
//            the kind and the title when they created it; the dates still
//            follow a receipt that arrives late.
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
const _filled = v => v !== null && v !== undefined && v !== '';

// Returns { changed: [fields] } when it wrote something, else null.
function refresh(reportId) {
  try {
    const r = reportId ? reports.getReport(reportId) : null;
    if (!r || (r.status !== 'draft' && r.status !== 'open')) return null;
    const company = users.getCompany(r.companyId) || {};
    const s = suggestCover(r.expenses, { baseCurrency: company.baseCurrency || 'SGD', today: localDate(company.timezone || 'Asia/Singapore') });
    // Nothing read and dated yet: nothing to say, so nothing is unsaid either.
    if (!s) return null;
    const { auto, user } = r.coverAi;
    const patch = {};
    let nextAuto = auto.filter(f => !user.includes(f));
    for (const f of r.status === 'draft' ? DRAFT_FIELDS : OPEN_FIELDS) {
      if (user.includes(f)) continue;
      if (r.status === 'open' && _filled(r[f]) && !auto.includes(f)) continue;
      const v = _filled(s[f]) ? s[f] : null;
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

module.exports = { refresh, refreshForReceipt, DRAFT_FIELDS, OPEN_FIELDS };
