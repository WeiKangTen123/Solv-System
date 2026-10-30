// A receipt kept as printed (expenses.printed, docs/plans/2026-10-30-receipt-as-printed.md):
// its rows in printed order, the subtotal as printed and the total paid. What
// the screens do with it that is not drawing: whether the rows add up (the
// currency's step, the same rule as main/receipts/printed.js), the tax rate
// groups the items can be put in, the words for a row, and adding, splitting
// and removing rows without losing what each `on` points at.
//
//   { v: 1, rows: [Row], subtotal: number|null, total: number }
//   Row = { kind, label, qty, unitPrice, amount, rate, included, worked,
//           category, onBehalfOf, taxRate, on }
//
// On screen a row's numbers are held as typed ("1.5", "") until saved;
// toRecord() turns a draft back into the record the server takes.
//
// No imports, so a test can load it from source.

export const KINDS = ['item', 'charge', 'discount', 'tax', 'rounding'];
export const KIND_WORD = { item: 'Item', charge: 'Charge', discount: 'Discount', tax: 'Tax', rounding: 'Rounding' };
// "Make it a charge", "an item".
export const KIND_A = { item: 'an item', charge: 'a charge', discount: 'a discount', tax: 'a tax', rounding: 'rounding' };

// A number typed or stored, or null for a blank or something that is not one.
export function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export const cents = v => Math.round((num(v) || 0) * 100);
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

// ── The currency's step ─────────────────────────────────────────────────────
// The smallest amount a receipt in that currency is rounded to, as the plan
// lists it. The rows "add up" when they come to the total within it; a
// rounding row on the receipt leaves only a cent, and a folio's per-charge
// taxes carry their own rounding, so for those half a percent of the total.
const STEP = { MYR: 0.05, SGD: 0.05, INR: 1, JPY: 1, KRW: 10, IDR: 100, VND: 1000 };
export const step = currency => STEP[String(currency || '').toUpperCase()] ?? 0.02;

const isIncluded = r => r.kind === 'tax' && !!r.included;
// Only a tax, a charge or a discount sits under another row, and only under
// an item, a charge or a discount (main/receipts/printed.js says the same).
const UNDER = new Set(['tax', 'charge', 'discount']);
const HOLDS = new Set(['item', 'charge', 'discount']);
const onOf = (rows, r, i) => (UNDER.has(r.kind) && Number.isInteger(r.on) && r.on >= 0 && r.on < rows.length && r.on !== i && HOLDS.has(rows[r.on].kind) ? r.on : null);
// A discount takes off however it is typed: 5.00 on a discount is −5.00, as
// the server keeps it.
const signed = r => (r.kind === 'discount' ? -Math.abs(cents(r.amount)) : cents(r.amount));

// The rows' sum (what is added up: everything but an included tax) against
// the total. `ok` when they come to it within the currency's step; within a
// cent when a rounding row takes the step up; and, when taxes are printed
// per charge as a folio prints them, within the larger of the step and half
// a percent of the total. `gap` is the total less the rows: positive, they
// are that much under it.
export function addsUp(printed, currency) {
  const rows = (printed && printed.rows) || [];
  const sumC = rows.reduce((s, r) => s + (isIncluded(r) ? 0 : signed(r)), 0);
  const totalC = cents(printed && printed.total);
  const gapC = totalC - sumC;
  const stepC = Math.round(step(currency) * 100);
  const perCharge = rows.some((r, i) => r.kind === 'tax' && onOf(rows, r, i) !== null);
  const rounding = rows.some(r => r.kind === 'rounding');
  const tolC = perCharge ? Math.max(stepC, Math.round(Math.abs(totalC) * 0.005)) : rounding ? 1 : stepC;
  return { sum: sumC / 100, total: totalC / 100, gap: gapC / 100, ok: !rows.length || Math.abs(gapC) <= tolC };
}

// ── Tax rate groups ─────────────────────────────────────────────────────────
// The rates the receipt's own taxes (those printed for the whole receipt,
// not under one row) come in, for the items' Tax column. A pair printed
// together, next to each other at one rate under two names (CGST 9% and
// SGST 9%), is one group at their sum, 18%, which is the rate an item of
// that receipt shows; the server's claim lines pair them by the same rule.
export function rateGroups(printed) {
  const rows = (printed && printed.rows) || [];
  const loose = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => r.kind === 'tax' && onOf(rows, r, i) === null && num(r.rate) !== null);
  const groups = new Map();
  const put = (rate, label) => {
    const key = +rate.toFixed(4);
    const g = groups.get(key) || { rate: key, labels: [] };
    if (label && !g.labels.some(x => same(x, label))) g.labels.push(label);
    groups.set(key, g);
  };
  for (let k = 0; k < loose.length; k++) {
    const p = loose[k], q = loose[k + 1];
    const label = String(p.r.label || '').trim();
    if (q && q.i === p.i + 1 && num(p.r.rate) === num(q.r.rate) && !!p.r.included === !!q.r.included && !same(p.r.label, q.r.label)) {
      put(num(p.r.rate) * 2, `${label}+${String(q.r.label || '').trim()}`);
      k++;
    } else put(num(p.r.rate), label);
  }
  return [...groups.values()].sort((a, b) => b.rate - a.rate);
}

// ── Words ───────────────────────────────────────────────────────────────────
// "6%", "9.5%": the rate as printed, without trailing zeros.
export const rateText = r => (num(r) === null ? '' : `${+num(r).toFixed(4)}%`);
// What a row says in a line: "SST 6% 1.58", "2 × Teh tarik 5.60". `money` is
// the page's formatter for an amount.
export function rowWords(r, money) {
  const qty = r.kind === 'item' && num(r.qty) !== null && num(r.qty) !== 1 ? `${+num(r.qty).toFixed(3)} × ` : '';
  const rate = r.kind !== 'item' && num(r.rate) !== null ? ` ${rateText(r.rate)}` : '';
  return `${qty}${String(r.label || '').trim() || KIND_WORD[r.kind] || 'Row'}${rate} ${money(num(r.amount) || 0)}`;
}

// The taxes a receipt prints, for the muted line under its amount in a case's
// receipts: one entry per (name, rate), a pair at the same rate joined
// ("CGST+SGST" at 18%), largest first. [] when it prints none.
export function taxSummary(printed) {
  const rows = (printed && printed.rows) || [];
  const m = new Map();
  for (const r of rows) {
    // A tax row with nothing on it says nothing about the amount.
    if (r.kind !== 'tax' || !cents(r.amount)) continue;
    const rate = num(r.rate);
    const label = String(r.label || '').trim() || 'Tax';
    const key = `${label.toLowerCase()}|${rate}`;
    const e = m.get(key) || { label, rate, amount: 0 };
    e.amount = Math.round((e.amount + (num(r.amount) || 0)) * 100) / 100;
    m.set(key, e);
  }
  const byRate = new Map();
  for (const e of m.values()) byRate.set(e.rate, [...(byRate.get(e.rate) || []), e]);
  const out = [];
  for (const [rate, list] of byRate) {
    if (rate !== null && list.length === 2) {
      out.push({ label: `${list[0].label}+${list[1].label}`, rate: +(rate * 2).toFixed(4), amount: Math.round((list[0].amount + list[1].amount) * 100) / 100 });
    } else out.push(...list);
  }
  return out.sort((a, b) => b.amount - a.amount);
}

// The places a currency's amounts are written to: 2 for most, 0 for the yen
// and the rupiah, 3 for the dinars. Anything Intl does not know gets 2.
export function minorDigits(currency) {
  const c = String(currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return 2;
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits; } catch { return 2; }
}

// ── The draft ───────────────────────────────────────────────────────────────
export function blankRow(kind, extra = {}) {
  return {
    kind, label: '', qty: kind === 'item' ? '1' : null, unitPrice: null, amount: '', rate: null,
    included: false, worked: false, category: null, onBehalfOf: null, taxRate: null, on: null, ...extra,
  };
}
// A row nobody has typed into: dropped on save rather than kept as a 0.
export const isBlank = r => !String(r.label || '').trim() && !cents(r.amount);

// The record as loaded, made a draft: the same rows, with numbers as text a
// box can hold, and the amounts written to the currency's places ("9.50").
// Only ever zeros added: a figure with more places than its currency keeps
// them, since showing a record must not change it.
export function toDraft(printed, currency) {
  if (!printed) return null;
  const d = minorDigits(currency);
  const t = v => (v === null || v === undefined ? null : String(v));
  const m = v => {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return t(v);
    const s = Number(v).toFixed(d);
    return Number(s) === Number(v) ? s : String(v);
  };
  return {
    v: printed.v || 1,
    rows: (printed.rows || []).map(r => ({
      ...blankRow(r.kind || 'item'), ...r,
      qty: t(r.qty), unitPrice: t(r.unitPrice), amount: m(r.amount) ?? '', rate: t(r.rate), taxRate: t(r.taxRate),
    })),
    subtotal: m(printed.subtotal),
    total: m(printed.total) ?? '',
  };
}

// The draft as the server takes it: numbers, null for a blank, untouched
// rows left out, and every `on` still pointing at the row it was on.
export function toRecord(draft) {
  if (!draft) return null;
  const keep = draft.rows.map(r => !isBlank(r));
  const rows = reindex(draft.rows, keep).map(r => {
    const tax = r.kind === 'tax';
    const item = r.kind === 'item';
    return {
      kind: KINDS.includes(r.kind) ? r.kind : 'item',
      label: String(r.label || '').trim(),
      qty: item ? num(r.qty) : null,
      unitPrice: item ? num(r.unitPrice) : null,
      amount: num(r.amount) ?? 0,
      rate: UNDER.has(r.kind) ? num(r.rate) : null,
      included: tax && !!r.included,
      worked: tax && !!r.worked,
      category: tax || r.kind === 'rounding' ? null : (String(r.category || '').trim() || null),
      onBehalfOf: String(r.onBehalfOf || '').trim() || null,
      taxRate: item ? num(r.taxRate) : null,
      on: UNDER.has(r.kind) && Number.isInteger(r.on) ? r.on : null,
    };
  });
  return { v: draft.v || 1, rows, subtotal: num(draft.subtotal), total: num(draft.total) ?? 0 };
}
export const sameRecord = (a, b) => JSON.stringify(toRecord(a)) === JSON.stringify(toRecord(b));

// The rows kept (keep[i]), with each `on` moved to where its row now is, and
// cleared when its row went.
function reindex(rows, keep) {
  const at = [];
  let n = 0;
  rows.forEach((_, i) => { at[i] = keep[i] ? n++ : null; });
  return rows.filter((_, i) => keep[i]).map(r => {
    const o = Number.isInteger(r.on) ? at[r.on] : null;
    return { ...r, on: o ?? null };
  });
}

// Puts `row` at index `at`, moving every `on` at or after it along by one.
export function insertRow(rows, at, row) {
  const moved = rows.map(r => (Number.isInteger(r.on) && r.on >= at ? { ...r, on: r.on + 1 } : r));
  const o = Number.isInteger(row.on) && row.on >= at ? row.on + 1 : row.on;
  return [...moved.slice(0, at), { ...row, on: o ?? null }, ...moved.slice(at)];
}
// The rows printed under row i (its discount, a folio's tax on it), and theirs.
export function dependents(rows, i) {
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    rows.forEach((r, j) => {
      if (j !== i && !out.has(j) && Number.isInteger(r.on) && (r.on === i || out.has(r.on))) { out.add(j); grew = true; }
    });
  }
  return [...out];
}
// Row i goes, and what is printed under it goes with it: a folio's tax on a
// charge that is not there is not on anything.
export function removeRow(rows, i) {
  const gone = new Set([i, ...dependents(rows, i)]);
  return reindex(rows, rows.map((_, j) => !gone.has(j)));
}
// Row i in two, each half the amount (the first keeps the odd cent) and,
// for an item of a whole number of things, half of them each.
export function splitRow(rows, i) {
  const r = rows[i];
  const c = cents(r.amount);
  const a = Math.ceil(c / 2), b = c - a;
  const q = num(r.qty);
  const halves = q !== null && Number.isInteger(q) && q >= 2 ? [String(Math.ceil(q / 2)), String(q - Math.ceil(q / 2))] : [r.qty, r.qty];
  const first = { ...r, amount: (a / 100).toFixed(2), qty: halves[0], worked: false };
  const second = { ...r, amount: (b / 100).toFixed(2), qty: halves[1], worked: false };
  return insertRow(rows.map((x, j) => (j === i ? first : x)), i + 1, { ...second, on: r.on });
}

// Where a new row of a kind goes in printed order: an item after the last
// item (and what is under it); a charge, discount or tax before the rounding
// and any included tax, which are printed last; rounding at the end.
export function insertAt(rows, kind) {
  if (kind === 'item') {
    let last = -1;
    rows.forEach((r, i) => { if (r.kind === 'item') last = i; });
    if (last < 0) return 0;
    const under = dependents(rows, last);
    return Math.max(last, ...under) + 1;
  }
  if (kind === 'rounding') return rows.length;
  const tail = rows.findIndex(r => r.on === null && (r.kind === 'rounding' || isIncluded(r)));
  return tail < 0 ? rows.length : tail;
}

// The category a receipt's new rows take: the one most of its items are in.
export function mainCategory(rows, fallback) {
  const n = new Map();
  for (const r of rows || []) if (r.kind === 'item' && r.category) n.set(r.category, (n.get(r.category) || 0) + 1);
  let best = null;
  for (const [c, k] of n) if (!best || k > n.get(best)) best = c;
  return best || fallback || null;
}

// ── What the reader read ────────────────────────────────────────────────────
// For each row on screen, the row the reader read that it stands for
// (aiRead.printed), or null for one typed in. Matched by name first, then by
// position among the rows of its kind, so one row removed does not make
// every row after it look changed.
export function matchRead(rows, readRows) {
  const read = readRows || [];
  const used = new Set();
  const out = rows.map(() => null);
  const near = (i, cand) => cand.sort((a, b) => Math.abs(a - i) - Math.abs(b - i))[0];
  rows.forEach((r, i) => {
    const cand = read.map((x, j) => j).filter(j => !used.has(j) && read[j].kind === r.kind && same(read[j].label, r.label) && String(r.label || '').trim());
    if (cand.length) { const j = near(i, cand); used.add(j); out[i] = j; }
  });
  for (const kind of KINDS) {
    const mine = rows.map((r, i) => i).filter(i => out[i] === null && rows[i].kind === kind);
    const theirs = read.map((x, j) => j).filter(j => !used.has(j) && read[j].kind === kind);
    mine.forEach((i, k) => { if (theirs[k] !== undefined) { used.add(theirs[k]); out[i] = theirs[k]; } });
  }
  return out.map(j => (j === null ? null : read[j]));
}
// Whether a row says something other than what was read off the paper: its
// kind, name, quantity, rate, amount or whether its tax was included. Who it
// was for and its category are the claimant's to decide, not the paper's.
export function differsFromRead(r, read) {
  if (!read) return false;
  return r.kind !== read.kind || !same(r.label, read.label) || cents(r.amount) !== cents(read.amount)
    || num(r.rate) !== num(read.rate) || (r.kind === 'item' && num(r.qty) !== num(read.qty))
    || (r.kind === 'tax' && !!r.included !== !!read.included);
}
// The printed parts of what was read, put back on a row.
export function readBack(r, read) {
  const t = v => (v === null || v === undefined ? null : String(v));
  return { ...r, kind: read.kind, label: read.label || '', qty: t(read.qty), unitPrice: t(read.unitPrice), amount: t(read.amount) ?? '',
           rate: t(read.rate), included: !!read.included, worked: !!read.worked };
}

// ── On screen ───────────────────────────────────────────────────────────────
// How the rows are drawn, in printed order:
//   items  the items, each with the rows printed under it (`subs`)
//   foot   the rest that add to the total: a row with its subs, or a fold of
//          a folio's per-charge taxes, one per (name, rate, included) that is
//          under two rows or more ("CGST 9% on 8 charges")
//   incl   the taxes included in the prices, shown under the total
//   subs   Map of row index to the rows printed under it, for a row under a
//          row that is itself under one
// A row's `on` is followed wherever its row is drawn.
export function arrange(rows) {
  const folds = new Map();
  rows.forEach((r, i) => {
    if (r.kind !== 'tax' || onOf(rows, r, i) === null) return;
    const key = `${String(r.label || '').trim().toLowerCase()}|${num(r.rate)}|${r.included ? 1 : 0}`;
    folds.set(key, [...(folds.get(key) || []), i]);
  });
  const folded = new Map();
  for (const [key, list] of folds) if (list.length >= 2) list.forEach(i => folded.set(i, key));

  const subs = new Map();
  rows.forEach((r, i) => {
    const o = onOf(rows, r, i);
    if (o === null || folded.has(i)) return;
    subs.set(o, [...(subs.get(o) || []), i]);
  });
  // A row is drawn under the one it is on; the rest are drawn where they are.
  const placed = (r, i) => onOf(rows, r, i) === null || folded.has(i);
  const items = [], foot = [], incl = [];
  const seenFold = new Set();
  rows.forEach((r, i) => {
    if (!placed(r, i)) return;
    if (folded.has(i)) {
      const key = folded.get(i);
      if (seenFold.has(key)) return;
      seenFold.add(key);
      const members = folds.get(key);
      const entry = { fold: key, members, label: r.label, rate: r.rate, included: !!r.included };
      (r.included ? incl : foot).push(entry);
      return;
    }
    const entry = { i, subs: subs.get(i) || [] };
    if (r.kind === 'item') items.push(entry);
    else if (isIncluded(r)) incl.push(entry);
    else foot.push(entry);
  });
  return { items, foot, incl, subs };
}

// "Claimed as: Meals 22.25 · Jane Tan Meals 5.60", from the lines the server
// made from the record.
export function claimedParts(lines) {
  return (lines || []).map(l => ({ who: String(l.onBehalfOf || '').trim() || null, category: l.category || 'Uncategorised', amount: Number(l.amount) || 0 }));
}
