// Dates where the company is, not in UTC.
//
// Receipt dates are written in the claimant's own day, and the exchange-rate
// day closes at the company's 23:55. Singapore runs eight hours ahead of UTC,
// so between midnight and 08:00 there UTC is still on the previous day: asked
// in UTC, "today" is yesterday for a third of every day.
function _parts(tz, d) {
  try {
    return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map(x => [x.type, x.value]));
  } catch {
    // An unknown zone is a misconfiguration, not a reason to answer nothing.
    return _parts('UTC', d);
  }
}

// YYYY-MM-DD in the zone.
function localDate(tz, d = new Date()) { const p = _parts(tz, d); return `${p.year}-${p.month}-${p.day}`; }
// Minutes past midnight in the zone.
function localMinutes(tz, d = new Date()) { const p = _parts(tz, d); return Number(p.hour) * 60 + Number(p.minute); }
// A calendar date moved by whole days; the zone does not matter to that.
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { localDate, localMinutes, addDays };
