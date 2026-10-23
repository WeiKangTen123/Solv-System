import { useEffect, useRef } from 'react';
import FlagList from '../ui/FlagList';
import { fmtDay, fmtMoney } from '../../utils/format';
import { hasRed } from './fields';
import { ALLOWANCE_LABEL, allowanceOf } from '../../utils/allowances';

// The receipts of a case in the order they are worth checking, for the left
// of the review page: what still needs the person, what the reader is still
// on, and what is done.
//
//   To check  every receipt not checked and not being read. Those with a red
//             flag first (a duplicate with them: it holds the claim back just
//             as a red flag does), then those with a yellow one, then the
//             rest; by date within each.
//   Reading   still with the reader, oldest first, with how far each read has
//             got and, for the owner, Try now and Type it myself.
//   Done      checked, by date.
//
// arrange(expenses) → { check, reading, done, all }, `all` in that order, is
// what the page moves through with J and K.
const _rank = e => (e.status === 'duplicate' || hasRed(e) ? 0 : (e.flags || []).length ? 1 : 2);
// Undated receipts after the dated ones: a date is the first thing checked,
// so one without is not where to start.
const _byDate = (a, b) => String(a.receiptDate || '9999').localeCompare(String(b.receiptDate || '9999')) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
const _byArrival = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));

export function arrange(expenses = []) {
  const check = [], reading = [], done = [];
  for (const e of expenses) (e.status === 'reading' ? reading : e.status === 'reviewed' ? done : check).push(e);
  check.sort((a, b) => _rank(a) - _rank(b) || _byDate(a, b));
  reading.sort(_byArrival);
  done.sort(_byDate);
  return { check, reading, done, all: [...check, ...reading, ...done] };
}

// A per diem or mileage is called what it is: it has no file, and its
// merchant is only the server's word for the same thing.
export const receiptName = e => ALLOWANCE_LABEL[allowanceOf(e)] || e.merchant || (e.receipt && e.receipt.originalName) || 'Receipt';
const amount = e => (Number(e.total) > 0 ? fmtMoney(e.total, e.currency) : '');

// How far one file's read has got, in words (receipts/read-queue.js states).
export function readWords(read) {
  if (!read) return 'Reading…';
  if (read.state === 'reading') return 'Reading now…';
  if (read.state === 'queued' && read.errorKind === 'unavailable') {
    const at = read.nextAt ? new Date(read.nextAt) : null;
    const when = at && at.getTime() > Date.now() ? ` Trying again at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ' Trying again shortly.';
    return `The AI is busy.${when}`;
  }
  if (read.state === 'queued' && read.errorKind) return 'Could not read it. Trying again shortly.';
  if (read.state === 'queued') return 'Waiting to be read';
  return 'Reading…';
}

// Props:
//   expenses    the case's receipts (each with `flags`).
//   selectedId  the receipt on screen.
//   onSelect    fn(expenseId).
//   reads       Map receiptId → read state, from GET /reports/:id/intake.
//   canAct      the owner of a case that is still open: Try now and Type it
//               myself are theirs (the read routes refuse anyone else).
//   onTryNow, onTypeIt  fn(receiptId).
//   busyId      a receipt id whose read action is running.
//   variant     'list' (default) or 'select': one box, for a phone or a
//               narrow window.
export default function ReviewQueue({ expenses, selectedId, onSelect, reads, canAct, onTryNow, onTypeIt, busyId, variant = 'list' }) {
  const { check, reading, done } = arrange(expenses);
  const rows = useRef(new Map());
  // The receipt on screen stays in sight in the list as J and K move it.
  useEffect(() => {
    const el = rows.current.get(selectedId);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const groups = [
    { id: 'check', title: 'To check', items: check },
    { id: 'reading', title: 'Reading', items: reading },
    { id: 'done', title: 'Done', items: done },
  ];

  if (variant === 'select') {
    const mark = e => (e.status === 'reviewed' ? '✓ ' : e.status === 'reading' ? '… ' : hasRed(e) || e.status === 'duplicate' ? '! ' : (e.flags || []).length ? '? ' : '');
    return (
      <select className="form-input rv-queue-select" value={selectedId || ''} onChange={e => onSelect(e.target.value)} aria-label="Receipt to review">
        {groups.filter(g => g.items.length).map(g => (
          <optgroup key={g.id} label={`${g.title} (${g.items.length})`}>
            {g.items.map(e => (
              <option key={e.id} value={e.id}>{mark(e)}{receiptName(e)} · {fmtDay(e.receiptDate)}{amount(e) ? ` · ${amount(e)}` : ''}</option>
            ))}
          </optgroup>
        ))}
      </select>
    );
  }

  return (
    <nav className="rv-queue" aria-label="Receipts in this case">
      {groups.map(g => (g.items.length || g.id === 'check') && (
        <section key={g.id} className={`rv-queue-group is-${g.id}`}>
          <h2 className="rv-queue-title">{g.title} <span className="ui-count">{g.items.length}</span></h2>
          {!g.items.length && <div className="rv-queue-empty">Nothing left to check.</div>}
          <ul>
            {g.items.map(e => {
              const on = e.id === selectedId;
              const read = e.receiptId && reads ? reads.get(e.receiptId) : null;
              const waiting = read && read.state === 'queued';
              return (
                <li key={e.id} className={`rv-row${on ? ' is-on' : ''}`} ref={el => { if (el) rows.current.set(e.id, el); else rows.current.delete(e.id); }}>
                  <button type="button" className="rv-row-main" aria-current={on ? 'true' : undefined} onClick={() => onSelect(e.id)}>
                    <span className="rv-row-mark">
                      {e.status === 'reviewed' ? <span className="rv-done-mark" aria-label="Checked">✓</span>
                        : e.status === 'reading' ? <span className="rv-reading-mark" aria-label="Being read">…</span>
                        : e.status === 'duplicate' ? <span className="ui-flag-pill is-red" title="A duplicate: delete it">dup</span>
                        : <FlagList flags={e.flags} compact />}
                    </span>
                    <span className="rv-row-name">{e.status === 'reading' ? (e.receipt && e.receipt.originalName) || receiptName(e) : receiptName(e)}</span>
                    <span className="rv-row-meta">
                      {e.status === 'reading' ? readWords(read) : <>{fmtDay(e.receiptDate)}{amount(e) && <> · <span className="rv-row-amount">{amount(e)}</span></>}</>}
                    </span>
                  </button>
                  {canAct && waiting && (
                    <div className="rv-row-actions">
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === e.receiptId} onClick={() => onTryNow(e.receiptId)}>Try now</button>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === e.receiptId} onClick={() => onTypeIt(e.receiptId)}>Type it myself</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}
