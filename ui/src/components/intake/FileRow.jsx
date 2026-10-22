import { useState } from 'react';
import { FlagList, ProgressBar } from '../ui';
import { fmtDay, fmtMoney } from '../../utils/format';
import { fmtClock, hasAmount, waitingRetry } from './intake-logic';

// One file on the intake list: what this page sent ({ local }, useUploader's
// row) and what the server made of it ({ file }, from /reports/:id/intake).
// Its state is said in words, with a mark beside it (✓ ◍ ↑ ! ? = ×) that has a
// shape of its own, so colour is never the only sign.
//
// A file that held several receipts (a hotel folio, a photo of three taxi
// slips) says how many and opens to list them.
//
// `act(name, row)` runs one of the row's buttons: 'retry' (send again),
// 'dismiss' (take the row off the page), 'cancel' (stop sending), 'tryNow'
// (read it now), 'typeIt' (stop waiting for the AI), 'remove' (delete what
// was stored). `working` disables them while one runs.
const MARK = { ok: '✓', busy: '◍', send: '↑', wait: '◷', warn: '?', bad: '!', dup: '=', no: '×', idle: '·', typed: '✎' };

const readable = e => !!(e.merchant || hasAmount(e));
const worst = flags => ((flags || []).some(f => f.level === 'red') ? 'red' : (flags || []).length ? 'yellow' : null);

// What the row says and offers, from its state.
function describe({ local, file }, now, nameOf) {
  if (!file) {
    const s = local.state;
    if (s === 'queued') return { tone: 'idle', mark: MARK.idle, words: 'Waiting to upload', actions: ['cancel'] };
    if (s === 'preparing') return { tone: 'busy', mark: MARK.send, words: 'Preparing…', actions: ['cancel'] };
    if (s === 'uploading') {
      const pct = Math.round((local.progress || 0) * 100);
      const words = pct < 100 ? `Uploading ${pct}%` : local.kind === 'zip' ? 'Unpacking the zip…' : local.kind === 'claim' ? 'Starting the import…' : 'Saving…';
      return { tone: 'busy', mark: MARK.send, words, actions: ['cancel'], progress: local.progress || 0 };
    }
    if (s === 'stored') return { tone: 'busy', mark: MARK.busy, words: 'Waiting to be read' };
    if (s === 'duplicate') {
      const same = local.dupOf && nameOf(local.dupOf);
      return { tone: 'warn', mark: MARK.dup, words: same ? `Same file as ${same}, already in this case` : local.message, actions: ['dismiss'] };
    }
    if (s === 'failed') return { tone: 'bad', mark: MARK.bad, words: local.message, actions: local.retryable ? ['retry', 'dismiss'] : ['dismiss'] };
    return { tone: 'bad', mark: MARK.no, words: local.message, actions: ['dismiss'] };
  }

  const read = file.read;
  const ex = file.expenses || [];
  if (read && read.state === 'queued') {
    if (waitingRetry(read, now)) {
      const left = fmtClock(Date.parse(read.nextAt) - now);
      const words = read.errorKind === 'unavailable' ? `AI busy, trying again in ${left}` : `Not read yet, trying once more in ${left}`;
      return { tone: 'warn', mark: MARK.wait, words, actions: ['tryNow', 'typeIt', 'remove'] };
    }
    return { tone: 'busy', mark: MARK.busy, words: 'Waiting to be read', actions: ['remove'] };
  }
  if (read && read.state === 'reading') return { tone: 'busy', mark: MARK.busy, words: 'Reading…' };
  if (read && read.state === 'failed') {
    const why = read.error || (ex[0] && ex[0].errorMsg) || 'The receipt could not be read.';
    return { tone: 'bad', mark: MARK.bad, words: why, actions: ['tryNow', 'remove'], tryLabel: 'Try again' };
  }
  if (read && read.state === 'cancelled') {
    return { tone: 'idle', mark: MARK.typed, words: 'Not read: type it in when you check the receipts', actions: ['remove'] };
  }
  if (!ex.length) return { tone: 'idle', mark: MARK.idle, words: 'No receipt was found in this file', actions: ['remove'] };
  if (ex.length > 1) {
    const level = ex.map(e => worst(e.flags)).includes('red') ? 'bad' : ex.some(e => worst(e.flags)) ? 'warn' : 'ok';
    return { tone: level, mark: level === 'ok' ? MARK.ok : level === 'bad' ? MARK.bad : MARK.warn, words: `${ex.length} receipts found`, many: true, actions: ['remove'] };
  }
  const e = ex[0];
  if (e.status === 'duplicate') return { tone: 'warn', mark: MARK.dup, words: 'Looks like a receipt you already uploaded', one: e, actions: ['remove'] };
  if (!readable(e)) {
    return { tone: 'warn', mark: MARK.bad, words: e.errorMsg || 'Read, but nothing could be made out. Type it in when you check the receipts.', actions: ['remove'] };
  }
  const level = worst(e.flags);
  return { tone: level === 'red' ? 'bad' : level ? 'warn' : 'ok', mark: level === 'red' ? MARK.bad : level ? MARK.warn : MARK.ok, one: e, actions: ['remove'] };
}

// "Taj Mumbai · 2 Sep"
function said(e) {
  return [e.merchant || 'Merchant not read', e.receiptDate ? fmtDay(e.receiptDate) : null].filter(Boolean).join(' · ');
}

function Figures({ e, base }) {
  if (!hasAmount(e)) return <span className="in-row-fig is-none">No amount yet</span>;
  const other = e.currency && e.currency !== base;
  return (
    <span className="in-row-fig">
      <span>{fmtMoney(e.total, e.currency)}</span>
      {other && <span className="in-row-base">{e.baseTotal !== null && e.baseTotal !== undefined ? fmtMoney(e.baseTotal, base) : `${base} rate to come`}</span>}
    </span>
  );
}

const LABEL = { retry: 'Retry', dismiss: 'Remove', cancel: 'Stop', tryNow: 'Try now', typeIt: 'Type it myself', remove: 'Remove' };

export default function FileRow({ row, now, base, nameOf, act, working = false }) {
  const [open, setOpen] = useState(false);
  const v = describe(row, now, nameOf);
  const name = (row.local && row.local.name) || (row.file && row.file.originalName) || 'Receipt';
  const ex = (row.file && row.file.expenses) || [];
  const flag = v.one && (v.one.flags || [])[0];
  const listId = `in-list-${row.key.replace(/[^a-z0-9-]/gi, '')}`;

  return (
    <li className={`in-row is-${v.tone}`}>
      <span className="in-mark" aria-hidden="true">{v.mark}</span>
      <div className="in-row-main">
        <div className="in-row-name" title={row.file && row.file.convertedFrom ? `${name} (converted from ${row.file.convertedFrom.replace('image/', '').toUpperCase()})` : name}>{name}</div>
        <div className="in-row-words">
          {v.one && !v.words ? said(v.one) : v.words}
          {v.one && v.words && <> · {said(v.one)}</>}
          {row.local && row.local.note && v.progress !== undefined && <span className="in-row-note"> · {row.local.note}</span>}
        </div>
        {flag && <div className={`in-row-flag is-${flag.level === 'red' ? 'red' : 'yellow'}`}>{flag.text}</div>}
        {v.progress !== undefined && v.progress < 1 && (
          <div className="in-row-progress"><ProgressBar value={Math.round(v.progress * 100)} label={`Uploading ${name}`} tone="info" /></div>
        )}
        {v.many && open && (
          <ul id={listId} className="in-sublist">
            {ex.map(e => (
              <li key={e.id} className="in-subrow">
                <span className="in-subrow-words">{readable(e) ? said(e) : (e.errorMsg || 'Nothing could be made out')}</span>
                <Figures e={e} base={base} />
                <FlagList flags={e.flags} compact />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="in-row-side">
        {v.one && readable(v.one) && <Figures e={v.one} base={base} />}
        {v.one && <FlagList flags={v.one.flags} compact />}
        {v.many && (
          <button type="button" className="btn btn-ghost btn-sm in-row-toggle" aria-expanded={open} aria-controls={open ? listId : undefined}
                  onClick={() => setOpen(o => !o)}>
            {open ? 'Hide' : 'Show'} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
            <span className="sr-only"> the receipts in {name}</span>
          </button>
        )}
        {(v.actions || []).map(a => (
          <button key={a} type="button" disabled={working} onClick={() => act(a, row)}
                  className={`btn btn-sm ${a === 'retry' || a === 'tryNow' ? 'btn-outline' : 'btn-ghost'}`}>
            {a === 'tryNow' && v.tryLabel ? v.tryLabel : LABEL[a]}
            <span className="sr-only"> {name}</span>
          </button>
        ))}
      </div>
    </li>
  );
}
