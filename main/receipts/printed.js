const { canonicalCategory } = require('../intake/categories');
const { fail } = require('../utils/http-error');
const { formatAmount } = require('../utils/money');

// A receipt as printed: every row that makes up the amount charged, in the
// order the receipt prints them, with the names and rates the receipt gives.
// It is the record of the receipt, and Solv never recalculates a figure on it.
//
// It replaced a read that kept five values and grouped the rest away. Items
// became one line per category ("Nasi Kandar Ayam Goreng +5 more"), the
// service charge, rounding and tip vanished into the line amounts, no tax
// name or rate was kept, and two rates were summed and split again by
// amount: a Kuala Lumpur hotel that printed Service Tax 8% of 24.64 on the
// room and 6% of 5.61 on dinner reached the PDF and Xero as 23.46 and 6.79.
//
//   { v: 1, rows: [Row], subtotal: number|null, total: number }
//
//   Row = { kind, label, qty, unitPrice, amount, rate, included, worked,
//           category, onBehalfOf, taxRate, on }
//
// What each field means is in docs/plans/2026-10-30-receipt-as-printed.md;
// the short of it is below, beside the code that reads it. The claim lines
// are made from the record (claimLines) every time it changes, and nobody
// types them while a record exists.

const KINDS = ['item', 'charge', 'discount', 'tax', 'rounding'];
const DEFAULT_LABEL = { item: 'Item', charge: 'Charge', discount: 'Discount', tax: 'Tax', rounding: 'Rounding' };
const MAX_ROWS = 300;
const MAX_LABEL = 120;
const MAX_PERSON = 80;
// Above this a number is a typing slip or an attack, not a receipt (edit.js).
const MAX_AMOUNT = 1e10;

// Cents the way the store counts them (store/expenses.js toCents): rounded on
// the decimal value, halves away from zero. Not required from there, because
// that loads the database and this file is worked out on its own.
function _cents(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return 0;
  return Math.sign(n) * Math.round(Number((Math.abs(n) * 100).toFixed(6)));
}
const _dollars = c => Math.round(c) / 100;
const _round = (n, places) => (places === 2 ? _cents(n) / 100 : Number(Number(n).toFixed(places)));
const _person = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// ── The currency's step ─────────────────────────────────────────────────────
//
// The smallest amount a receipt in the currency moves by, near enough: a
// ringgit or Singapore bill rounds to 5 sen, a rupee or a yen bill to the
// unit. Rows that miss the total by no more than this add up. The screen
// asks the same question (ui/src/utils/printed.js) and must answer it the
// same way.
const STEPS = { MYR: 0.05, SGD: 0.05, INR: 1, JPY: 1, KRW: 10, IDR: 100, VND: 1000 };
function step(currency) {
  return STEPS[String(currency || '').trim().toUpperCase()] ?? 0.02;
}

// What the rows come to: everything but a tax already inside the prices. A
// discount takes off however it was typed, as validate keeps it.
function rowsSum(printed) {
  const rows = (printed && Array.isArray(printed.rows)) ? printed.rows : [];
  return _dollars(rows.filter(r => !(r.kind === 'tax' && r.included))
    .reduce((s, r) => s + (r.kind === 'discount' ? -Math.abs(_cents(r.amount)) : _cents(r.amount)), 0));
}
// The row `r` (at `i`) is under, when it may be: only a tax, a charge or a
// discount sits under another row, and only under an item, a charge or a
// discount. null otherwise.
const UNDER = new Set(['tax', 'charge', 'discount']);
const HOLDS = new Set(['item', 'charge', 'discount']);
const _under = (rows, r, i) => (UNDER.has(r.kind) && Number.isInteger(r.on) && r.on >= 0 && r.on < rows.length && r.on !== i && HOLDS.has(rows[r.on].kind) ? r.on : null);

// Whether the rows come to the total. Within the currency's step; within a
// cent when a rounding row is there to take up the step; within half a
// percent when taxes are printed per charge, as a folio prints them, since
// each of those carries its own rounding (the JW folio's come to one rupee
// over). Never a reason to refuse anything: the record is kept as it was
// read, and the screen says quietly how far out it is.
//
// { ok, sum, gap }: gap is the total less the rows, so a positive gap is
// that much under the total. No rows at all is nothing to say.
function addsUp(printed, currency) {
  const rows = (printed && Array.isArray(printed.rows)) ? printed.rows : [];
  const total = _cents(printed && printed.total);
  const sum = _cents(rowsSum(printed));
  const gap = total - sum;
  const perCharge = rows.some((r, i) => r.kind === 'tax' && _under(rows, r, i) !== null);
  const rounding = rows.some(r => r.kind === 'rounding');
  const slack = perCharge ? Math.max(_cents(step(currency)), Math.round(Math.abs(total) * 0.005))
              : rounding ? 1
              : _cents(step(currency));
  return { ok: !rows.length || Math.abs(gap) <= slack, sum: _dollars(sum), gap: _dollars(gap) };
}

// ── Checking a record ───────────────────────────────────────────────────────
//
// What a person sends (PUT /api/expenses/:id/printed) and what the reader
// made are both put through this, so a stored record always has this shape.
// Anything wrong is refused with a sentence that names the row; nothing is
// guessed, except two things a person means without saying: a discount takes
// off (5.00 typed on a discount is −5.00), and a row with no name is called
// what it is.

function _number(v, what, { min = -Infinity, max = Infinity, places = 2, nullable = true } = {}) {
  if (v === null || v === undefined || v === '') {
    if (nullable) return null;
    fail(400, `${what} is missing.`);
  }
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
  if (!Number.isFinite(n)) fail(400, `${what} must be a number.`);
  if (n < min || n > max) {
    fail(400, min === 0 && max === 100 ? `${what} must be a percentage from 0 to 100.`
            : min >= 0 ? `${what} must be a number from ${min} up.` : `${what} is too large.`);
  }
  return _round(n, places);
}

function _row(r, i) {
  const at = `Row ${i + 1}`;
  if (!r || typeof r !== 'object' || Array.isArray(r)) fail(400, `${at} is not a row.`);
  const kind = typeof r.kind === 'string' ? r.kind.trim().toLowerCase() : '';
  if (!KINDS.includes(kind)) fail(400, `${at} must be an item, a charge, a discount, a tax or a rounding.`);
  if (r.label !== null && r.label !== undefined && typeof r.label !== 'string') fail(400, `${at}'s name must be text.`);
  let label = String(r.label || '').replace(/\s+/g, ' ').trim();
  if (label.length > MAX_LABEL) fail(400, `${at}'s name is longer than ${MAX_LABEL} characters.`);
  if (!label) label = DEFAULT_LABEL[kind];
  const named = `${at} (${label})`;

  let amount = _number(r.amount, `${named}: the amount`, { min: -MAX_AMOUNT, max: MAX_AMOUNT, nullable: false });
  if (kind === 'discount') amount = -Math.abs(amount);
  else if (kind !== 'rounding' && amount < 0) fail(400, `${named}: the amount cannot be below zero; a discount is what takes something off.`);
  if (Object.is(amount, -0)) amount = 0;

  const item = kind === 'item';
  const rated = kind === 'charge' || kind === 'discount' || kind === 'tax';
  let category = null;
  if ((item || kind === 'charge' || kind === 'discount') && r.category !== null && r.category !== undefined && r.category !== '') {
    category = canonicalCategory(r.category);
    if (!category) fail(400, `${named}: unknown category "${String(r.category).slice(0, 40)}".`);
  }
  let onBehalfOf = null;
  if (kind !== 'rounding' && typeof r.onBehalfOf === 'string' && r.onBehalfOf.trim()) onBehalfOf = r.onBehalfOf.replace(/\s+/g, ' ').trim().slice(0, MAX_PERSON);

  return {
    kind, label,
    qty: item ? _number(r.qty, `${named}: the quantity`, { min: 0, max: 1e6, places: 3 }) : null,
    unitPrice: item ? _number(r.unitPrice, `${named}: the unit price`, { min: -MAX_AMOUNT, max: MAX_AMOUNT, places: 4 }) : null,
    amount,
    rate: rated ? _number(r.rate, `${named}: the rate`, { min: 0, max: 100, places: 3 }) : null,
    included: kind === 'tax' && r.included === true,
    worked: kind === 'tax' && r.worked === true,
    category,
    onBehalfOf,
    taxRate: item ? _number(r.taxRate, `${named}: the tax rate`, { min: 0, max: 100, places: 3 }) : null,
    // Only a tax, a charge or a discount sits under another row. Anything
    // else that says it does is let stand on its own.
    on: rated && r.on !== null && r.on !== undefined && r.on !== '' ? Number(r.on) : null,
  };
}

// Returns the record cleaned to its shape, or fails with a 400 that says what
// is wrong.
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Send the receipt as printed: its rows and its total.');
  if (input.v !== undefined && input.v !== null && input.v !== 1) fail(400, 'This record is of a version the server does not know.');
  if (!Array.isArray(input.rows)) fail(400, 'The receipt as printed needs its rows, as a list.');
  if (input.rows.length > MAX_ROWS) fail(400, `A receipt can have at most ${MAX_ROWS} rows.`);
  const total = _number(input.total, 'The total', { min: 0, max: MAX_AMOUNT, nullable: false });
  const subtotal = _number(input.subtotal, 'The subtotal', { min: 0, max: MAX_AMOUNT });
  const rows = input.rows.map(_row);
  rows.forEach((r, i) => {
    if (r.on === null) return;
    const at = `Row ${i + 1} (${r.label})`;
    if (!Number.isInteger(r.on) || r.on < 0 || r.on >= rows.length) fail(400, `${at} sits under a row that is not there.`);
    if (r.on === i) fail(400, `${at} cannot sit under itself.`);
    const under = rows[r.on];
    if (under.kind === 'tax' || under.kind === 'rounding') fail(400, `${at} sits under row ${r.on + 1}, which is a ${under.kind}; a row sits under an item, a charge or a discount.`);
  });
  // However far round: a charge under a discount under that charge.
  rows.forEach((r, i) => {
    const seen = new Set([i]);
    for (let k = r.on; k !== null; k = rows[k].on) {
      if (seen.has(k)) fail(400, `Row ${i + 1} (${r.label}) and row ${k + 1} sit under each other.`);
      seen.add(k);
    }
  });
  return { v: 1, rows, subtotal, total };
}

// ── The tax figure ──────────────────────────────────────────────────────────
//
// expenses.tax is the sum of the tax rows, added and included, so the CSV,
// the assistant and everything written before the record keep working. A tax
// total printed in the receipt's own tax summary wins over that sum when the
// receipt is read (the JW folio prints 6,759 against per-charge lines of
// 6,760), and a record whose tax rows are the ones it had keeps the tax it
// had: that figure may be the summary's. null when no tax is printed.
const _taxKey = rows => JSON.stringify(rows.filter(r => r.kind === 'tax').map(r => [String(r.label).toLowerCase(), r.rate, _cents(r.amount), !!r.included]));
function taxOf(record, { summary = null, was = null, tax = null } = {}) {
  const rows = (record && Array.isArray(record.rows)) ? record.rows : [];
  const total = _cents(record && record.total);
  const s = summary === null || summary === undefined ? null : _cents(summary);
  if (s !== null && s > 0 && (total <= 0 || s <= total)) return _dollars(s);
  if (was && Array.isArray(was.rows) && tax !== null && tax !== undefined && _taxKey(was.rows) === _taxKey(rows)) return tax;
  const taxes = rows.filter(r => r.kind === 'tax');
  if (!taxes.length) return null;
  return _dollars(taxes.reduce((n, r) => n + _cents(r.amount), 0));
}

// ── Claim lines from the record ─────────────────────────────────────────────
//
// One line per (category, person), as the lines have always been, each with
// the taxes inside its amount:
//
//   line.taxes = [{ label, rate, amount, included, gross }]
//
// amount is the line's share of that tax; gross the part of the line's amount
// the tax was charged on, with the tax when it was added, which is what Xero
// takes as an inclusive line. Taxes charged on the same amount (CGST and SGST
// on one room) share a gross. The shares of one tax add up to the amount
// printed, to the cent; the lines add up to the total, to the cent.
//
// Where each row goes:
//   item       its own (category, person).
//   on         a row printed under another goes where that row goes.
//   charge,    over the items by amount: the items of its own category when it
//   discount   names one (a city tax on the rooms), else every item; only that
//              person's when it names a person.
//   rounding   the claimant's own line in the receipt's category.
//   tax        the items whose tax rate is its rate (or, for a pair printed
//              together such as CGST 9% and SGST 9%, their sum); every item
//              when no item shows a tax rate. By what it was charged on.
// An added tax adds to the line's amount; an included one is already in it
// and is only recorded.
//
// What a tax was charged on is the items, their discounts, and whichever of
// their charges the printed rate bears out: a Kuala Lumpur bill's SST of
// 1.58 at 6% is on the food and the 10% service charge (26.29), a Berlin
// hotel's MwSt of 23.55 at 7% is on the rooms without the city tax (360.00),
// and a San Francisco grill's sales tax of 8.54 is on the food without the
// tip. The rate only chooses between those; no figure is changed by it.
//
// Rows nowhere near the total (more than 15%, or a unit) give one line for
// the whole total; any smaller difference goes to the claimant's own line in
// the receipt's category, as the lines did before the record.

const _near = (a, b) => a !== null && b !== null && a !== undefined && b !== undefined && Math.abs(Number(a) - Number(b)) < 0.0005;

// Splits `cents` over the keys of `weights` in proportion, to the cent, the
// last share taking what rounding leaves. With nothing to weigh by, evenly.
function _split(cents, weights) {
  const keys = [...weights.keys()];
  if (!keys.length) return new Map();
  let all = keys.reduce((s, k) => s + Math.max(0, weights.get(k)), 0);
  const w = k => (all > 0 ? Math.max(0, weights.get(k)) : 1);
  if (!(all > 0)) all = keys.length;
  const out = new Map();
  let given = 0;
  keys.forEach((k, idx) => {
    const share = idx === keys.length - 1 ? cents - given : Math.round((cents * w(k)) / all);
    out.set(k, share);
    given += share;
  });
  return out;
}

function claimLines(printed, fallbackCategory, { description = null } = {}) {
  if (!printed || !Array.isArray(printed.rows)) return [];
  const total = _cents(printed.total);
  if (!(total > 0)) return [];
  const cat = canonicalCategory(fallbackCategory) || 'Other';
  const rows = printed.rows.map((r, i) => ({ ...r, i, c: _cents(r.amount) }));
  const at = k => (Number.isInteger(k) && k >= 0 && k < rows.length ? rows[k] : null);

  // The items, and a stand-in for them when the receipt itemises nothing: the
  // amount the other rows leave, so the taxes and charges have something to
  // sit on.
  let items = rows.filter(r => r.kind === 'item');
  if (!items.length) {
    const rest = rows.filter(r => r.kind !== 'item' && !(r.kind === 'tax' && r.included)).reduce((s, r) => s + r.c, 0);
    items = [{ kind: 'item', label: description || null, i: -1, c: Math.max(0, total - rest), category: null, onBehalfOf: null, taxRate: null }];
  }
  for (const it of items) {
    it.category0 = canonicalCategory(it.category) || cat;
    it.key = `${it.category0}|${it.onBehalfOf || ''}`;
  }
  const own = `${cat}|`;

  // The row another row finally sits under, however far round, or null.
  const anchor = r => {
    let cur = r;
    const seen = new Set();
    while (cur && cur.kind !== 'item' && at(cur.on) && !seen.has(cur.i)) { seen.add(cur.i); cur = at(cur.on); }
    return cur && cur !== r ? cur : null;
  };
  const byPerson = (list, r) => {
    if (!r.onBehalfOf) return list;
    const mine = list.filter(it => _person(it.onBehalfOf) === _person(r.onBehalfOf));
    return mine.length ? mine : list;
  };

  // How a charge or discount is spread over the items: Map(item → weight).
  const placed = new Map();
  const placement = r => {
    if (placed.has(r)) return placed.get(r);
    let out;
    const a = anchor(r);
    if (a && a.kind === 'item') out = new Map([[a, 1]]);
    else if (a) out = placement(a);
    else {
      let list = items;
      const ofCat = r.category ? items.filter(it => it.category0 === canonicalCategory(r.category)) : [];
      if (ofCat.length) list = ofCat;
      list = byPerson(list, r);
      const weigh = list.some(it => it.c > 0);
      out = new Map(list.map(it => [it, weigh ? Math.max(0, it.c) : 1]));
    }
    const sum = [...out.values()].reduce((s, v) => s + v, 0) || 1;
    for (const [k, v] of out) out.set(k, v / sum);
    placed.set(r, out);
    return out;
  };

  // What each item carries from the charges and discounts on it, in cents
  // (fractions while they are spread): { discount, rated, unrated }.
  const carried = new Map(items.map(it => [it, { discount: 0, rated: 0, unrated: 0 }]));
  for (const r of rows) {
    if (r.kind !== 'charge' && r.kind !== 'discount') continue;
    for (const [it, w] of placement(r)) {
      const c = carried.get(it);
      if (!c) continue;
      if (r.kind === 'discount') c.discount += r.c * w;
      else if (r.rate !== null && r.rate !== undefined) c.rated += r.c * w;
      else c.unrated += r.c * w;
    }
  }

  // ── The taxes: which items each is on, and on how much of them ──
  const taxes = rows.filter(r => r.kind === 'tax');
  const loose = taxes.filter(t => !anchor(t));
  // A pair printed together: neighbouring whole-receipt tax rows at one rate
  // under different names (CGST 9% and SGST 9%), whose rate group is their sum.
  const groupRate = new Map();
  for (const t of loose) groupRate.set(t, t.rate);
  for (let k = 0; k + 1 < loose.length; k++) {
    const [p, q] = [loose[k], loose[k + 1]];
    if (q.i === p.i + 1 && p.rate !== null && _near(p.rate, q.rate) && !!p.included === !!q.included
        && String(p.label).toLowerCase() !== String(q.label).toLowerCase()) {
      groupRate.set(p, p.rate + q.rate); groupRate.set(q, p.rate + q.rate);
    }
  }
  const rated = items.filter(it => it.taxRate !== null && it.taxRate !== undefined);
  const looseTargets = t => {
    let list;
    if (!rated.length) list = items;
    else {
      list = rated.filter(it => _near(it.taxRate, groupRate.get(t)) || _near(it.taxRate, t.rate));
      if (!list.length) list = items.filter(it => it.taxRate === null || it.taxRate === undefined);
      if (!list.length) list = rated.filter(it => it.taxRate > 0);
      if (!list.length) list = items;
    }
    return byPerson(list, t);
  };

  // For each tax: Map(item → cents it was charged on), and a name for that
  // set of items and amounts, which taxes on the same amount share.
  const bases = new Map();
  for (const t of taxes) {
    const direct = at(t.on);
    let base, sig;
    if (direct && direct.kind !== 'item') {
      // A tax on a charge (a folio's CGST on its service charge) is on that charge.
      base = new Map([...placement(direct)].map(([it, w]) => [it, direct.c * w]));
      sig = `row${direct.i}`;
    } else {
      const list = direct ? [direct] : looseTargets(t);
      const sum = f => list.reduce((s, it) => s + f(it), 0);
      const cands = {
        b: it => it.c + carried.get(it).discount + carried.get(it).rated,
        a: it => it.c + carried.get(it).discount,
        c: it => it.c + carried.get(it).discount + carried.get(it).rated + carried.get(it).unrated,
      };
      let pick = 'b';
      if (t.rate !== null && t.rate !== undefined && t.c > 0) {
        const R = groupRate.get(t) ?? t.rate;
        const implied = B => (t.included ? (B * t.rate) / (100 + R) : (B * t.rate) / 100);
        let best = Infinity;
        for (const k of ['b', 'a', 'c']) {
          const off = Math.abs(implied(sum(cands[k])) - t.c);
          if (off < best - 0.5) { best = off; pick = k; }
        }
      }
      base = new Map(list.map(it => [it, cands[pick](it)]));
      sig = `${list.map(it => it.i).join(',')}:${pick}`;
    }
    bases.set(t, { base, sig });
  }

  // ── Every row's share of every line, to the cent ──
  const lines = new Map();
  const line = key => {
    if (!lines.has(key)) {
      const [category, person] = key.split(/\|(.*)$/s);
      lines.set(key, { key, category, onBehalfOf: person || null, cents: 0, names: [], count: 0, taxes: [] });
    }
    return lines.get(key);
  };
  const byLine = weights => {
    const out = new Map();
    for (const [it, w] of weights) out.set(it.key, (out.get(it.key) || 0) + w);
    return out;
  };
  for (const it of items) {
    const l = line(it.key);
    l.cents += it.c;
    l.count++;
    if (it.label && !l.names.length && it.c > 0) l.names.push(String(it.label).replace(/\s+/g, ' ').trim());
  }
  for (const r of rows) {
    if (r.kind === 'charge' || r.kind === 'discount') {
      for (const [key, share] of _split(r.c, byLine(placement(r)))) line(key).cents += share;
    } else if (r.kind === 'rounding') {
      const mine = [...lines.values()].filter(l => !l.onBehalfOf);
      const to = lines.get(own) || mine.sort((x, y) => y.cents - x.cents)[0] || [...lines.values()].sort((x, y) => y.cents - x.cents)[0];
      to.cents += r.c;
    }
  }
  for (const t of taxes) {
    const { base, sig } = bases.get(t);
    const weights = byLine(base);
    const shares = _split(t.c, weights);
    for (const [key, share] of shares) {
      const l = line(key);
      if (!t.included) l.cents += share;
      l.taxes.push({ t, sig, line: key, share, base: weights.get(key) || 0 });
    }
  }

  // ── Each line's taxes, with what they were charged on ──
  const taxesOf = l => {
    const out = new Map();
    for (const x of l.taxes) {
      if (!x.share && !(x.base > 0) && x.t.c) continue;
      const added = l.taxes.filter(y => y.line === x.line && y.sig === x.sig && !y.t.included).reduce((s, y) => s + y.share, 0);
      const gross = Math.round(x.base) + added;
      const k = `${String(x.t.label).toLowerCase()}|${x.t.rate}|${!!x.t.included}`;
      const e = out.get(k) || { label: x.t.label, rate: x.t.rate ?? null, amount: 0, included: !!x.t.included, gross: 0 };
      e.amount += x.share; e.gross += gross;
      out.set(k, e);
    }
    return [...out.values()].map(e => ({ ...e, amount: _dollars(e.amount), gross: _dollars(e.gross) }));
  };
  const merge = (into, from) => { into.cents += from.cents; into.count += from.count; into.taxes.push(...from.taxes); if (!into.names.length) into.names.push(...from.names); };

  const label = l => (l.names[0] ? `${l.names[0].slice(0, 80)}${l.count > 1 ? ` +${l.count - 1} more` : ''}` : (description || null));
  const oneLine = () => {
    const all = { key: own, category: cat, onBehalfOf: null, cents: total, names: [], count: 0, taxes: [] };
    for (const l of lines.values()) { all.taxes.push(...l.taxes); all.count += l.count; if (!all.names.length) all.names.push(...l.names); }
    return [{ category: cat, description: description || label(all), amount: _dollars(total), onBehalfOf: null, taxes: taxesOf(all) }];
  };

  // A line that comes to nothing or less is not a charge: what it holds goes
  // to the claimant's own line, made if there is none.
  for (const l of [...lines.values()]) {
    if (l.cents > 0 || l.key === own) continue;
    lines.delete(l.key);
    merge(line(own), l);
  }
  const sum = [...lines.values()].reduce((s, l) => s + l.cents, 0);
  const off = total - sum;
  if (Math.abs(off) > Math.max(100, Math.round(total * 0.15))) return oneLine();
  if (off || (lines.has(own) && lines.get(own).cents <= 0)) {
    const l = line(own);
    // Ten people's 10.00 against a total of 87.00: the difference is nobody
    // else's, and the claimant's line cannot carry it, so the total is one line.
    if (l.cents + off <= 0) return oneLine();
    l.cents += off;
  }
  const list = [...lines.values()].filter(l => l.cents > 0);
  if (!list.length) return oneLine();
  return list.sort((x, y) => y.cents - x.cents)
    .map(l => ({ category: l.category, description: label(l), amount: _dollars(l.cents), onBehalfOf: l.onBehalfOf, taxes: taxesOf(l) }));
}

// ── What changed, in words ──────────────────────────────────────────────────
//
// For the change log (store/changes.js), row by row, as a person would say
// it: "SST 6% 1.58 → 1.60", "Added Teh tarik 5.60", "Removed Rounding −0.02",
// "Category of Roti canai Meals → Other", "Service Charge 10% → 0%". Rows
// have no ids, so a row is found again by its kind, name and rate, then by
// its kind and name (its rate changed), then by its kind and amount (it was
// renamed), then by its name (its kind changed); anything left was added or
// removed.

const _pct = v => (v === null || v === undefined ? 'no rate' : `${Number(v)}%`);
const _money = n => formatAmount(n).replace(/^-/, '−');
const _name = r => `${r.label}${r.rate !== null && r.rate !== undefined ? ` ${Number(r.rate)}%` : ''}`;
const _a = kind => ({ item: 'an item', charge: 'a charge', discount: 'a discount', tax: 'a tax', rounding: 'a rounding' }[kind] || kind);

function _pairs(before, after) {
  const matched = new Array(after.length).fill(-1);
  const used = new Set();
  const lower = s => String(s || '').toLowerCase();
  const passes = [
    (b, a) => b.kind === a.kind && lower(b.label) === lower(a.label) && _near(b.rate ?? -1, a.rate ?? -1),
    (b, a) => b.kind === a.kind && lower(b.label) === lower(a.label),
    (b, a) => b.kind === a.kind && _cents(b.amount) === _cents(a.amount),
    (b, a) => lower(b.label) === lower(a.label),
  ];
  for (const same of passes) {
    for (let j = 0; j < after.length; j++) {
      if (matched[j] >= 0) continue;
      let best = -1;
      for (let i = 0; i < before.length; i++) {
        if (used.has(i) || !same(before[i], after[j])) continue;
        if (best < 0 || Math.abs(i - j) < Math.abs(best - j)) best = i;
      }
      if (best >= 0) { matched[j] = best; used.add(best); }
    }
  }
  return { matched, removed: before.map((b, i) => i).filter(i => !used.has(i)) };
}

function rowChanges(beforeRows, afterRows) {
  const before = Array.isArray(beforeRows) ? beforeRows : [], after = Array.isArray(afterRows) ? afterRows : [];
  const { matched, removed } = _pairs(before, after);
  const out = [];
  const under = (list, r) => (Number.isInteger(r.on) && list[r.on] ? String(list[r.on].label) : null);
  after.forEach((a, j) => {
    if (matched[j] < 0) { out.push(`Added ${_name(a)} ${_money(a.amount)}`); return; }
    const b = before[matched[j]];
    if (b.kind !== a.kind) out.push(`${b.label} is now ${_a(a.kind)}`);
    if (String(b.label) !== String(a.label)) out.push(`Renamed ${b.label} to ${a.label}`);
    if (!_near(b.rate ?? -1, a.rate ?? -1)) out.push(`${a.label} ${_pct(b.rate)} → ${_pct(a.rate)}`);
    if (_cents(b.amount) !== _cents(a.amount)) out.push(`${_name(a)} ${_money(b.amount)} → ${_money(a.amount)}`);
    if (!_near(b.qty ?? -1, a.qty ?? -1)) out.push(`Quantity of ${a.label} ${b.qty ?? 'none'} → ${a.qty ?? 'none'}`);
    if (!_near(b.unitPrice ?? -1, a.unitPrice ?? -1)) out.push(`Unit price of ${a.label} ${b.unitPrice === null || b.unitPrice === undefined ? 'none' : _money(b.unitPrice)} → ${a.unitPrice === null || a.unitPrice === undefined ? 'none' : _money(a.unitPrice)}`);
    if ((b.category || null) !== (a.category || null)) out.push(`Category of ${a.label} ${b.category || 'none'} → ${a.category || 'none'}`);
    if (_person(b.onBehalfOf) !== _person(a.onBehalfOf)) {
      out.push(!a.onBehalfOf ? `${a.label} no longer for ${b.onBehalfOf}` : b.onBehalfOf ? `${a.label} for ${b.onBehalfOf} → ${a.onBehalfOf}` : `${a.label} now for ${a.onBehalfOf}`);
    }
    if (a.kind === 'tax' && !!b.included !== !!a.included) out.push(`${_name(a)} now ${a.included ? 'included in the prices' : 'added to the prices'}`);
    if (!_near(b.taxRate ?? -1, a.taxRate ?? -1)) out.push(`Tax on ${a.label} ${b.taxRate === null || b.taxRate === undefined ? 'not shown' : _pct(b.taxRate)} → ${a.taxRate === null || a.taxRate === undefined ? 'not shown' : _pct(a.taxRate)}`);
    const ub = under(before, b), ua = under(after, a);
    if (ub !== ua) out.push(ua ? `${_name(a)} now on ${ua}` : `${_name(a)} now on the whole receipt`);
  });
  for (const i of removed) out.push(`Removed ${_name(before[i])} ${_money(before[i].amount)}`);
  return out;
}

// The whole change to a record in one sentence for the log: at most five
// rows named, then how many more. null when nothing about the rows changed.
const NAMED = 5;
function describeChange(before, after) {
  const was = before && Array.isArray(before.rows) ? before : null;
  const now = after && Array.isArray(after.rows) ? after : null;
  if (!was && !now) return null;
  if (!now) return 'No longer kept as printed';
  let list;
  if (!was) {
    const items = now.rows.filter(r => r.kind === 'item').length;
    list = [`${items} item${items === 1 ? '' : 's'}`, ...now.rows.filter(r => r.kind !== 'item').map(r => `${_name(r)} ${_money(r.amount)}`)];
  } else {
    list = rowChanges(was.rows, now.rows);
    if (!list.length) return null;
  }
  const more = list.length - NAMED;
  const said = `${list.slice(0, NAMED).join(' · ')}${more > 0 ? ` · and ${more} more` : ''}`;
  return was ? said : `Kept as printed: ${said}`;
}

module.exports = { validate, step, rowsSum, addsUp, taxOf, claimLines, rowChanges, describeChange, KINDS, MAX_ROWS, MAX_LABEL };
