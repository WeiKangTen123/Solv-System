const db    = require('../db');
const users = require('../store/users');
const { localDate } = require('../utils/zone-date');
const { suggestCover, countryName, monthSpan, dayRange, CURRENCY_COUNTRY, MONTH, usable, ranked } = require('./cover-suggest');
const { openTarget } = require('./cover-auto');

// The help a case's details get from its receipts, for the person to take or
// leave: what the AI would put in each field, the receipts it was made from,
// and choices for the purpose. Nothing here writes anything.
//
// caseSuggestion  the cover as the AI sees it. A draft gets the whole of it
//                 (cover-suggest.js), the AI's kind included. A case already
//                 created keeps the kind its owner chose, so a Trip whose
//                 receipts happen to be local is not offered "Month", and its
//                 dates follow cover-auto's open rule as if the AI kept them:
//                 widened only to receipts beside them, so one stray receipt
//                 from seven weeks later does not offer 49 nights. Handing a
//                 field back to the AI (routes/cover.js) gives exactly what is
//                 suggested here.
// purposeDraft    a plain account of the receipts: what they were for by
//                 category, where, and when. Built by rules, never by the
//                 model, and it never says why: the business reason is on no
//                 receipt, and a reason made up would be the AI's words on a
//                 claim the person signs.
// pastPurposes    the person's own words from their earlier cases.
//
// Both purpose choices are offered and nothing else: the field stays as it
// is until the person picks one, and they can edit what they picked.

// The company's currency and day, unless the caller has them already.
function _opts(report, opts) {
  if (opts && opts.today) return { baseCurrency: opts.baseCurrency || 'SGD', today: opts.today };
  const c = users.getCompany(report.companyId) || {};
  return { baseCurrency: c.baseCurrency || 'SGD', today: localDate(c.timezone || 'Asia/Singapore') };
}

const _iso2 = c => { const v = String(c || '').trim().toUpperCase(); return /^[A-Z]{2}$/.test(v) ? v : null; };
const _city = c => (typeof c === 'string' ? c.replace(/\s+/g, ' ').trim() || null : null);
const _byDate = (a, b) => a.receiptDate.localeCompare(b.receiptDate);
const _and = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

// Where a receipt was: the country printed on it, or failing that its
// currency's. Home counts here: "4 receipts in Singapore" is where they were.
function _country(e) {
  return _iso2(e.country) || CURRENCY_COUNTRY[String(e.currency || '').trim().toUpperCase()] || null;
}
// The towns and countries of some receipts, busiest first. A town that is a
// country of its own ("Singapore") is said once, as the country.
function _places(list) {
  const countries = ranked(list.map(_country)).map(countryName).filter(Boolean);
  const said = countries.map(n => n.toLowerCase());
  const cities = ranked(list.map(e => _city(e.city))).filter(c => !said.includes(c.toLowerCase()));
  return { cities, countries };
}

// The receipts a suggestion was made from, as the panel's source line says
// them: "from 4 receipts in Mumbai and Pune, 31 Aug – 4 Sep".
function _basis(list) {
  if (!list.length) return null;
  const sorted = [...list].sort(_byDate);
  const { cities, countries } = _places(sorted);
  return { receipts: sorted.length, cities: cities.slice(0, 3), countries: countries.slice(0, 3),
           from: sorted[0].receiptDate, to: sorted[sorted.length - 1].receiptDate };
}

// A title for the kind the case already is, from the receipts inside its
// dates (`within` is cover-suggest's view of them) and the dates it would have.
function _title(kind, from, to, within) {
  const lo = from && to && from > to ? to : from, hi = from && to && from > to ? from : to;
  if (!lo || !hi) return within ? within.title : null;
  if (kind === 'period') {
    const span = lo.slice(0, 7) === hi.slice(0, 7) ? `${MONTH[Number(lo.slice(5, 7)) - 1]} ${lo.slice(0, 4)}` : monthSpan(lo, hi);
    return `${span} claims`;
  }
  if (kind === 'trip') {
    const span = monthSpan(lo, hi);
    const names = within && within.kind === 'trip' ? (within.basis.countries || []).map(countryName).filter(Boolean) : [];
    if (names.length === 1) return `${names[0]} trip, ${span}`;
    if (names.length === 2) return `${names[0]} and ${names[1]} trip, ${span}`;
    return `Trip, ${span}`;
  }
  return `Receipts, ${dayRange(lo, hi)}`;
}

// The suggestion and the receipts it was made from: every usable receipt of a
// draft; of a case already created, those inside the dates it would have. The
// source line and the purpose draft speak of the same receipts, so a stray
// one from seven weeks later is in neither. Null when none is read and dated.
function _made(report, opts) {
  if (!report) return null;
  const o = _opts(report, opts);
  const s = suggestCover(report.expenses, o);
  if (!s) return null;
  if (report.status === 'draft') {
    return { suggestion: { kind: s.kind, title: s.title, periodFrom: s.periodFrom, periodTo: s.periodTo, destination: s.destination, nights: s.nights },
             list: usable(report.expenses, o.today) };
  }
  const t = openTarget(report, s, { ...o, asIfAi: true });
  const inside = usable(t.inside, o.today);
  return { suggestion: { kind: report.kind, title: _title(report.kind, t.periodFrom, t.periodTo, t.within), periodFrom: t.periodFrom, periodTo: t.periodTo,
                         destination: t.destination, nights: t.nights },
           list: inside.length ? inside : usable(report.expenses, o.today) };
}

// { kind, title, periodFrom, periodTo, destination, nights, basis }, or null
// when no receipt in the case is read and dated yet.
function caseSuggestion(report, opts) {
  const m = _made(report, opts);
  return m ? { ...m.suggestion, basis: _basis(m.list) } : null;
}

// What a receipt was for, in the words a purpose uses. Air & Transport says
// flights only when the reader saw a ticket; a taxi or parking is local
// transport; anything else in it (a train, a transfer on a folio) is just
// transport.
const PHRASE = {
  Lodging: 'hotel stays', Meals: 'meals', Entertainment: 'entertainment', Phone: 'phone and internet', 'Fuel/Mileage': 'fuel',
  'Office Supplies': 'office supplies', 'Software/Utilities': 'software and utilities', 'Medical/Dental': 'medical costs', Other: 'other costs',
};
const ORDER = ['hotel stays', 'flights', 'transport', 'local transport', 'meals', 'entertainment', 'fuel', 'phone and internet',
               'office supplies', 'software and utilities', 'medical costs', 'other costs'];
const MAX_PHRASES = 4;
function _phrase(category, docType) {
  if (category === 'Air & Transport') return docType === 'flight' ? 'flights' : ['ride', 'parking'].includes(docType) ? 'local transport' : 'transport';
  return PHRASE[category] || null;
}

// "Hotel stays and local transport in Mumbai and Pune, 1–4 Sep 2026", or
// null when no receipt is read and dated. Only what the receipts say: their
// categories, their towns (or countries) and their days. The receipts are the
// ones the suggestion was made from, so a stray receipt does not add a city.
function purposeDraft(report, opts) {
  const m = _made(report, opts);
  if (!m || !m.list.length) return null;
  const list = [...m.list].sort(_byDate);
  const seen = new Set();
  for (const e of list) {
    const cats = (e.lines || []).map(l => l.category).filter(Boolean);
    for (const c of cats.length ? cats : [e.category]) { const p = _phrase(c, e.docType); if (p) seen.add(p); }
  }
  // A taxi beside a train is all transport.
  if (seen.has('transport')) seen.delete('local transport');
  let phrases = ORDER.filter(p => seen.has(p));
  if (phrases.length > MAX_PHRASES) phrases = [...phrases.slice(0, MAX_PHRASES - 1).filter(p => p !== 'other costs'), 'other costs'];
  const what = phrases.length ? _and(phrases) : 'expenses';
  const { cities, countries } = _places(list);
  const where = cities.length ? _and(cities.slice(0, 3)) : countries.length ? _and(countries.slice(0, 3)) : null;
  const text = `${what}${where ? ` in ${where}` : ''}, ${dayRange(list[0].receiptDate, list[list.length - 1].receiptDate)}`;
  return (text[0].toUpperCase() + text.slice(1)).slice(0, 500);
}

// The person's own purposes from their other cases, newest case first, each
// said once however often it was used. Only ever theirs: another person's
// purposes name their clients and their reasons.
const PAST_MAX = 3;
function pastPurposes(userId, { exceptCase = null, except = null, limit = PAST_MAX } = {}) {
  if (!userId) return [];
  const rows = db.prepare(`SELECT id, purpose FROM expense_reports
                           WHERE user_id = ? AND purpose IS NOT NULL AND TRIM(purpose) != ''
                           ORDER BY created_at DESC, rowid DESC LIMIT 100`).all(userId);
  const out = [], said = new Set(except ? [String(except).trim().toLowerCase()] : []);
  for (const r of rows) {
    if (r.id === exceptCase) continue;
    const text = String(r.purpose).replace(/\s+/g, ' ').trim();
    const key = text.toLowerCase();
    if (said.has(key)) continue;
    said.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { caseSuggestion, purposeDraft, pastPurposes, PAST_MAX };
