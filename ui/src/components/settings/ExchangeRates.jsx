import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { fmtRate } from '../../utils/format';
import { formatDate, formatDateTime, formatTime } from '../../utils/formatDate';
import { useVisiblePolling } from '../../utils/useVisiblePolling';

// The live board: one row per currency, its rate now, the move since the last
// close, and under each row the daily log that receipts are priced from.
//
// The server does the fetching and the closing (main/fx/live.js); this page
// only reads the board once a minute while it is open and visible.

const KIND = {
  live: 'Live, closes tonight',
  close: 'Daily close',
  lookup: 'Looked up for a receipt',
  manual: 'Set by an admin',
};
const POLL_MS = 60 * 1000;
const num = { fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' };
const muted = { fontSize: 11.5, color: 'var(--text-muted)' };

// "1 SGD = 75.22 INR": two places once the number is big enough to read that
// way, four significant figures when it is small.
function fmtInverse(n) {
  if (!(n > 0)) return '';
  if (n >= 10) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return Number(n.toPrecision(4)).toString();
}

// The direction of the move with its size. Movement is not a state, so it
// carries no colour: colour on this app means something needs you.
function fmtChange(c) {
  if (c === null || c === undefined || !Number.isFinite(c)) return '—';
  const pct = Math.abs(c * 100);
  if (pct < 0.005) return '0.00%';
  return `${c > 0 ? '▲' : '▼'} ${pct.toFixed(2)}%`;
}

const zoneLabel = tz => (tz === 'Asia/Singapore' ? 'SGT' : tz);

// A rate's day is a calendar date, not a moment: "2026-10-05" is 5 Oct
// everywhere. Formatted in UTC so a company west of Greenwich does not see
// the day before.
const fmtDay = iso => (iso ? formatDate(`${String(iso).slice(0, 10)}T00:00:00Z`, 'UTC') : '—');

// What an action said, shown beside the control that was pressed. These used
// to go to the top of the settings page, a long scroll away from a rate typed
// into a currency's log, so a refusal went unseen.
function Note({ note, at }) {
  if (!note || note.at !== at) return null;
  return <div className={`alert alert-${note.tone}`} style={{ marginTop: 10, marginBottom: 0 }}>{note.text}</div>;
}

export default function ExchangeRates({ isAdmin, currencies = [] }) {
  const [board, setBoard] = useState(null);
  const [open, setOpen] = useState(null);         // the currency whose log is showing
  const [log, setLog] = useState(null);
  const [busy, setBusy] = useState('');
  const [watchInput, setWatchInput] = useState('');
  const [rateForm, setRateForm] = useState({ date: '', rate: '' });
  const [appId, setAppId] = useState('');
  // { at: 'board' | 'watch' | 'log' | 'source', tone, text }
  const [note, setNote] = useState(null);

  const notify = useCallback((tone, text, at = 'board') => setNote({ tone, text, at }), []);
  const load = useCallback(() => api.get('/fx/board').then(setBoard).catch(e => notify('error', e.message)), [notify]);
  const loadLog = useCallback(ccy => (ccy ? api.get(`/fx/log/${ccy}`).then(setLog).catch(e => notify('error', e.message, 'log')) : Promise.resolve()), [notify]);

  useEffect(() => { load(); }, [load]);
  useVisiblePolling(() => Promise.all([load(), loadLog(open)]), POLL_MS);
  useEffect(() => {
    setLog(null);
    if (open) { setRateForm({ date: '', rate: '' }); loadLog(open); }
  }, [open, loadLog]);

  // Every admin action answers with the whole board, so the screen never has
  // to guess what changed.
  // Resolves true when it worked, so a caller clears its form only then: a
  // rate or an App ID that was refused used to be wiped from the form anyway.
  // `at` is where the answer is shown: beside the control that was pressed.
  async function act(label, at, fn, done) {
    setBusy(label);
    setNote(null);
    try {
      const next = await fn();
      if (next && next.rows) setBoard(next);
      if (open) await loadLog(open);
      if (done) notify('success', done, at);
      return true;
    } catch (e) { notify('error', e.message, at); return false; }
    finally { setBusy(''); }
  }

  if (!board) return <div className="card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>{note ? `Could not load the exchange rates: ${note.text}` : 'Loading exchange rates…'}</div>;
  const { base, timezone, source } = board;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div className="card-title">Exchange Rates</div>
            <div className="card-subtitle" style={{ marginBottom: 0 }}>
              Receipts are priced at the closing rate for their receipt date. Today&rsquo;s receipts use the live rate and move to
              tonight&rsquo;s close at {board.closesAt} {zoneLabel(timezone)}, unless their case has already been claimed.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={muted}>
              {board.updatedAt ? `Live · updated ${formatTime(board.updatedAt, timezone)} ${zoneLabel(timezone)}` : 'Not refreshed yet'}
            </span>
            {isAdmin && (
              <button className="btn btn-outline btn-sm" disabled={!!busy}
                      onClick={() => act('refresh', 'board', () => api.post('/fx/live/refresh', {}), 'Rates refreshed.')}>
                {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
          </div>
        </div>
        <Note note={note} at="board" />

        <div style={{ overflowX: 'auto', marginTop: 14 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Currency</th>
                <th style={{ textAlign: 'right' }}>Live rate</th>
                <th style={{ textAlign: 'right' }}>Today</th>
                <th style={{ textAlign: 'right' }}>Last close</th>
                <th style={{ textAlign: 'right' }}>Receipts</th>
                <th aria-label="Open the log" />
              </tr>
            </thead>
            <tbody>
              {board.rows.map(r => {
                const isOpen = open === r.currency;
                const drift = r.live && r.live.divergence !== null && Math.abs(r.live.divergence) > 0.01;
                return (
                  <Fragment key={r.currency}>
                    <tr onClick={() => setOpen(isOpen ? null : r.currency)} style={{ cursor: 'pointer', background: isOpen ? 'var(--bg-hover)' : undefined }}
                        aria-expanded={isOpen} tabIndex={0} role="button"
                        onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpen(isOpen ? null : r.currency); } }}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.currency} to {base}</div>
                        <div style={muted}>{r.name || (r.pinned ? 'Watched' : '')}{r.pinned && r.name ? ' · watched' : ''}</div>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {r.live ? (
                          <>
                            <div style={num} title={`${String(r.live.rate)} · ${r.live.sourceLabel}, published ${r.live.providerTime ? formatDateTime(r.live.providerTime, timezone) : fmtDay(r.live.providerDate)}`}>{fmtRate(r.live.rate)}</div>
                            <div style={muted}>1 {base} = {fmtInverse(r.inverse)} {r.currency}</div>
                            {r.manualToday && <div style={{ ...muted, color: 'var(--text-secondary)' }}>today set at {fmtRate(r.manualToday.rate)}</div>}
                            {drift && <div style={{ fontSize: 11.5, color: 'var(--warning)' }}>providers differ by {(Math.abs(r.live.divergence) * 100).toFixed(2)}%</div>}
                          </>
                        ) : <span style={{ color: 'var(--warning)', fontSize: 12.5 }}>no rate yet</span>}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap', ...num, color: 'var(--text-secondary)' }}>{fmtChange(r.change)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {r.lastClose ? (
                          <>
                            <div style={num}>{fmtRate(r.lastClose.rate)}</div>
                            <div style={muted}>{fmtDay(r.lastClose.date)}{r.lastClose.closed ? '' : ' · looked up'}</div>
                          </>
                        ) : <span style={muted}>—</span>}
                      </td>
                      <td style={{ textAlign: 'right', ...num }}>{r.receipts}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{isOpen ? '▾' : '›'}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--bg-secondary)', padding: '12px 14px' }}>
                          <CurrencyLog
                            row={r} base={base} timezone={timezone} log={log} isAdmin={isAdmin} busy={busy} note={note}
                            rateForm={rateForm} setRateForm={setRateForm}
                            onSetRate={e => {
                              e.preventDefault();
                              act('rate', 'log', () => api.post('/fx/rates', { from: r.currency, date: rateForm.date, rate: Number(rateForm.rate) }).then(load), 'Rate saved for that day.')
                                .then(ok => { if (ok) setRateForm({ date: '', rate: '' }); });
                            }}
                            onRemoveRate={date => act('rate', 'log', () => api.delete(`/fx/rates?from=${encodeURIComponent(r.currency)}&to=${encodeURIComponent(base)}&date=${encodeURIComponent(date)}`).then(load), 'Rate removed. The day is priced from the providers again.')}
                            // The log closes on success, so the answer shows on the board.
                            onUnwatch={() => act('unwatch', 'board', () => api.delete(`/fx/watch/${r.currency}`), `${r.currency} is no longer watched.`).then(ok => { if (ok) setOpen(null); })}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!board.rows.length && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              No foreign currency yet. A currency appears here as soon as a receipt in it is read{isAdmin ? ', or add one below to watch it' : ''}.
            </div>
          )}
        </div>

        {isAdmin && (
          <form style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}
                onSubmit={e => { e.preventDefault(); act('watch', 'watch', () => api.post('/fx/watch', { currency: watchInput }), `${watchInput} added to the board.`).then(ok => { if (ok) setWatchInput(''); }); }}>
            <datalist id="fx-watch-options">
              {currencies.filter(c => c.code !== base).map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
            </datalist>
            <input className="form-input" style={{ maxWidth: 140 }} placeholder="e.g. THB" maxLength={3} required list="fx-watch-options"
                   value={watchInput} onChange={e => setWatchInput(e.target.value.toUpperCase().slice(0, 3))} aria-label="Currency to watch" />
            <button className="btn btn-outline btn-sm" type="submit" disabled={!!busy || watchInput.length !== 3}>
              {busy === 'watch' ? 'Adding…' : '+ Watch another currency'}
            </button>
          </form>
        )}
        <Note note={note} at="watch" />
      </div>

      {isAdmin && (
        <div className="card">
          <div className="card-title">Live source</div>
          {source.keyed ? (
            <>
              <div className="card-subtitle">
                Open Exchange Rates, refreshed every {source.everyMinutes} minutes. If it fails, the board falls back to the
                European Central Bank and ExchangeRate-API until it answers again.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
                <span>App ID <code>{source.keyMasked}</code></span>
                <button className="btn btn-ghost btn-sm" disabled={!!busy}
                        onClick={() => act('source', 'source', () => api.put('/fx/live/source', { appId: '' }), 'Back on the daily feeds.')}>Remove</button>
              </div>
            </>
          ) : (
            <>
              <div className="card-subtitle">
                The European Central Bank, then ExchangeRate-API for the currencies it does not publish. Both publish once a day,
                so the live rate moves when they publish. For a rate that moves through the day, add an Open Exchange Rates App ID.
                Their free plan updates hourly within 1,000 requests a month, and this board uses about 744 refreshing every {source.everyMinutes} minutes.
              </div>
              <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
                    onSubmit={e => { e.preventDefault(); act('source', 'source', () => api.put('/fx/live/source', { appId }), 'Open Exchange Rates connected.').then(ok => { if (ok) setAppId(''); }); }}>
                <input className="form-input" style={{ flex: 1, minWidth: 220 }} placeholder="Open Exchange Rates App ID" required
                       value={appId} onChange={e => setAppId(e.target.value.trim())} aria-label="Open Exchange Rates App ID" autoComplete="off" />
                <button className="btn btn-primary" type="submit" disabled={!!busy || !appId}>{busy === 'source' ? 'Checking…' : 'Check and save'}</button>
                <a className="btn btn-outline" href="https://openexchangerates.org/signup" target="_blank" rel="noreferrer">Get an App ID ↗</a>
              </form>
            </>
          )}
          <Note note={note} at="source" />
        </div>
      )}
    </div>
  );
}

// The daily log for one currency, newest first, with an admin's controls for
// setting the rate of a particular day.
function CurrencyLog({ row, base, timezone, log, isAdmin, busy, note, rateForm, setRateForm, onSetRate, onRemoveRate, onUnwatch }) {
  if (!log || log.currency !== row.currency) return <div style={muted}>{note && note.at === 'log' ? note.text : 'Loading the daily log…'}</div>;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{row.currency} to {base} · daily log</div>
        {isAdmin && row.pinned && (
          <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={onUnwatch}>Stop watching</button>
        )}
      </div>
      {log.entries.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ background: 'transparent' }}>
            <thead>
              <tr>
                <th>Date</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th style={{ textAlign: 'right' }}>1 {base} =</th>
                <th>Source</th>
                <th style={{ textAlign: 'right' }}>Used by</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {log.entries.map(e => (
                <tr key={e.date}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDay(e.date)}</td>
                  <td style={{ textAlign: 'right', ...num }} title={String(e.rate)}>
                    {fmtRate(e.rate)}
                    {e.overrides && <div style={muted} title={String(e.overrides.rate)}>was {fmtRate(e.overrides.rate)}</div>}
                  </td>
                  <td style={{ textAlign: 'right', ...num, color: 'var(--text-secondary)' }}>{fmtInverse(1 / e.rate)} {row.currency}</td>
                  <td>
                    <div style={{ fontSize: 12.5 }}>{KIND[e.kind] || e.kind}</div>
                    <div style={muted}>
                      {e.kind === 'manual' ? (e.enteredBy || 'an admin') : e.sourceLabel}
                      {e.providerDate && e.providerDate !== e.date && e.kind !== 'manual' ? ` · priced ${fmtDay(e.providerDate)}` : ''}
                    </div>
                    {(e.notes || []).length > 0 && <div style={{ fontSize: 11.5, color: 'var(--warning)' }}>{e.notes.join('; ')}</div>}
                  </td>
                  <td style={{ textAlign: 'right', ...num }}>{e.usedBy ? `${e.usedBy} receipt${e.usedBy === 1 ? '' : 's'}` : '—'}</td>
                  {isAdmin && (
                    <td style={{ textAlign: 'right' }}>
                      {e.kind === 'manual' && <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => onRemoveRate(e.date)}>Remove</button>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div style={muted}>No rates logged for {row.currency} yet.</div>}

      {isAdmin && (
        <form onSubmit={onSetRate} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Set the {row.currency} rate for</span>
          <input className="form-input" type="date" style={{ maxWidth: 170 }} required value={rateForm.date}
                 onChange={e => setRateForm({ ...rateForm, date: e.target.value })} aria-label="Date" />
          <input className="form-input" type="number" step="any" min="0" style={{ maxWidth: 150 }} required
                 placeholder={row.live ? fmtRate(row.live.rate) : '0.0134'}
                 value={rateForm.rate} onChange={e => setRateForm({ ...rateForm, rate: e.target.value })} aria-label={`${base} per ${row.currency}`} />
          <button className="btn btn-primary btn-sm" type="submit" disabled={!!busy}>{busy === 'rate' ? 'Saving…' : 'Save rate'}</button>
          <span style={muted}>Beats the providers for that day, for a monthly table or a correction.</span>
        </form>
      )}
      <Note note={note} at="log" />
    </div>
  );
}
