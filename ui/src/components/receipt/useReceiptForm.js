import { useCallback, useRef, useState } from 'react';
import { api } from '../../api/client';
import { pick, lineRows, sameLines, cents } from './fields';
import { toDraft, toRecord, sameRecord } from '../../utils/printed';

// What is typed into one receipt's boxes and its lines, against what they said
// when they were loaded, and how a save sends only the difference. Both
// receipt pages hold their receipt this way; it was written out inside
// ExpenseReview.jsx, and the reasons for each rule came with it.
//
//   const rf = useReceiptForm(REVIEW_FIELDS, { oneLineFromTotal: true });
//   rf.loadFrom(expense)                       // a receipt to show
//   rf.loadFrom(expense, { keepEdits: true })  // a poll: typing wins
//   await rf.save(expense.id)                  // PATCH what changed, then the lines
//
// `fields` are keys of FIELD_DEFS. `oneLineFromTotal`: a receipt with no lines
// gets one, made from the total, when it is saved. The review page asks for
// this because it shows a one-line receipt as fields only; the receipt page
// shows its lines and lets the person add them.
//
// A receipt kept as printed (expense.printed, utils/printed.js) is held here
// too, as `printed`: its rows as typed, changed through editPrinted(fn). Its
// lines are then the server's, made from the rows on every save, so they are
// never sent; nor are the total and the tax, which come from the rows. Save
// sends the record with PUT /expenses/:id/printed after the fields' PATCH.
// `printed` is null for a receipt without one, which keeps its lines here.
//
// Returns { form, lines, printed, printedChanged, dirty, isDirty(), markClean(),
// loadFrom, set, setLine, editLines, editPrinted, save, totalCents,
// linesCents, reconciled }. `dirty` is for
// drawing; isDirty() answers at the moment it is asked, for a leave guard.
// markClean() forgets the edits without touching the boxes: the receipt was
// deleted, and nothing typed on it is left to lose.
export function useReceiptForm(fields, { oneLineFromTotal = false } = {}) {
  const [form, setForm] = useState({});
  const [lines, setLines] = useState([]);
  const [printed, setPrinted] = useState(null);
  // The record as loaded, to tell whether the rows were changed.
  const [printedBase, setPrintedBase] = useState(null);
  const [dirty, setDirtyShown] = useState(false);
  // Set as soon as a box is touched, cleared by a save or a reload that was
  // asked for. The poll runs every 2.5s while the reader works, and without
  // this it overwrote whatever was being typed at the time.
  const dirtyRef = useRef(false);
  // What the boxes said when they were loaded. Save sends only what differs:
  // sending every field wrote back blanks for anything that had changed on
  // the server since, such as what the reader filled in a moment later.
  const baseline = useRef({ form: {}, lines: '[]', raw: [], printed: null });
  const fieldsKey = fields.join(',');

  const touch = () => { if (!dirtyRef.current) { dirtyRef.current = true; setDirtyShown(true); } };
  const settle = () => { dirtyRef.current = false; setDirtyShown(false); };
  const isDirty = useCallback(() => dirtyRef.current, []);
  const markClean = useCallback(() => { dirtyRef.current = false; setDirtyShown(false); }, []);

  // `extra` adds boxes that are not receipt fields (the receipt page's case).
  const loadFrom = useCallback((e, { keepEdits = false, extra = {} } = {}) => {
    if (keepEdits && dirtyRef.current) return;
    const f = e ? { ...pick(e, fieldsKey.split(',')), ...extra } : {};
    const ls = e ? lineRows(e) : [];
    const p = e ? toDraft(e.printed) : null;
    setForm(f); setLines(ls); setPrinted(p); setPrintedBase(p);
    baseline.current = { form: f, lines: sameLines(ls), raw: ls, printed: p };
    dirtyRef.current = false; setDirtyShown(false);
  }, [fieldsKey]);

  const set = (k, v) => {
    touch();
    setForm(f => ({ ...f, [k]: v }));
    // A single line follows the total, as it does on the server when the
    // total is saved (receipts/edit.js). Left behind on screen, it showed a
    // red "≠ total" and held Check back over a difference Save was about to
    // put right by itself.
    if (k === 'total') setLines(ls => (ls.length === 1 ? [{ ...ls[0], amount: v }] : ls));
  };
  const setLine = (i, k, v) => { touch(); setLines(ls => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l))); };
  // Called from a click, so the lines on screen are the ones it works from.
  const editLines = fn => {
    touch();
    const next = fn(lines);
    setLines(next);
    // Back to one line, the category box speaks for it again, so it says what
    // that line says rather than what it said before the split.
    if (lines.length > 1 && next.length === 1 && next[0].category) setForm(f => ({ ...f, category: next[0].category }));
  };

  // The rows as printed: fn(draft) => draft, from a click or a box.
  const editPrinted = fn => { touch(); setPrinted(p => (p ? fn(p) : p)); };

  // Sends what changed: the fields in one PATCH, then the lines if they moved.
  // Throws the server's refusal. `withCase` also files the receipt in the
  // case picked in form.reportId (the owner's, while the case is open).
  async function save(expenseId, { withCase = false } = {}) {
    const was = baseline.current.form;
    const body = {};
    for (const k of fields) {
      // A split has no category of its own; its lines carry one each.
      if (k === 'category' && lines.length > 1) continue;
      if (String(form[k] ?? '') === String(was[k] ?? '')) continue;
      body[k] = k === 'currency' ? String(form[k] || '').toUpperCase() : form[k];
    }
    // An emptied currency box means "not typed yet", not "this receipt has no
    // currency": sending it cleared the currency and the rate with it.
    if (body.currency === '') delete body.currency;
    if (withCase && 'reportId' in form && (form.reportId || '') !== (was.reportId || '')) body.reportId = form.reportId || null;
    // A record's total and tax are its rows'; the boxes for them are not shown.
    if (printed) { delete body.total; delete body.tax; }
    let changed = false;
    if (Object.keys(body).length) { await api.patch(`/expenses/${expenseId}`, body); changed = true; }
    if (printed) {
      if (!sameRecord(printed, baseline.current.printed)) {
        await api.put(`/expenses/${expenseId}/printed`, { printed: toRecord(printed) });
        changed = true;
      }
      settle();
      return changed;
    }
    // The server has already moved a single line with a new total, so a line
    // that only followed the total needs no second request.
    const was1 = baseline.current.raw;
    const followed = 'total' in body && lines.length === 1 && was1.length === 1 && cents(lines[0].amount) === cents(form.total);
    const compare = followed ? [{ ...lines[0], amount: was1[0].amount }] : lines;
    if (lines.length && sameLines(compare) !== baseline.current.lines) {
      await api.put(`/expenses/${expenseId}/lines`, { lines: lines.map(l => ({ ...l, amount: Number(l.amount), onBehalfOf: String(l.onBehalfOf || '').trim() || null })) });
      changed = true;
    } else if (oneLineFromTotal && !lines.length && !was1.length && cents(form.total) > 0) {
      // A receipt the reader could not make out arrives with no lines at all,
      // and one with no lines can never be checked. The total typed here
      // becomes its one line, as it did in the old check table.
      await api.put(`/expenses/${expenseId}/lines`, { lines: [{ category: form.category || null, description: null, amount: Number(form.total), onBehalfOf: null }] });
      changed = true;
    }
    settle();
    return changed;
  }

  const totalCents = cents(form.total);
  const linesCents = lines.reduce((s, l) => s + cents(l.amount), 0);
  // A record's lines are made by the server to come to its total, so they
  // always do.
  const reconciled = printed ? true : lines.length > 0 && totalCents === linesCents;
  const printedChanged = !!printed && !sameRecord(printed, printedBase);
  return { form, lines, printed, printedChanged, dirty, isDirty, markClean, loadFrom, set, setLine, editLines, editPrinted, save, totalCents, linesCents, reconciled };
}
