import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { fmtRate } from '../../utils/format';
import { formatDateTime, formatTime } from '../../utils/formatDate';
import { useVisiblePolling } from '../../utils/useVisiblePolling';
import { useViewMode } from '../../context/ViewModeContext';
import CurrencyDetail from './CurrencyDetail';
import ChooseCurrencies from './ChooseCurrencies';
import CodeBadge from './CodeBadge';
import { REGIONS, num, muted, fmtInverse, fmtChange, fmtDay, zoneLabel } from './fxFormat';

// The live board: the currencies an admin chose (a new company starts with
// ten — eight in Asia, the euro and the US dollar), grouped by region, then
// any other currency receipts use. One row per currency: its rate now, the
// move since the last close, the last close, and how many receipts use it.
// A row opens the currency in a window of its own (CurrencyDetail): its chart,
// its daily log and an admin's controls.
//
// The server does the fetching and the closing (main/fx/live.js); this page
// only reads the board once a minute while it is open and visible.

const POLL_MS = 60 * 1000;

// What an action said, shown beside the control that was pressed. These used
// to go to the top of the settings page, a long scroll away from the control,
// so a refusal went unseen.
function Note({ note, at }) {
  if (!note || note.at !== at) return null;
  return <div className={`alert alert-${note.tone}`} style={{ marginTop: 10, marginBottom: 0 }}>{note.text}</div>;
}

// The rows in the order they are listed, under their group headings: the
// chosen ones by region, then those only receipts put there.
function groupRows(rows) {
  const groups = REGIONS.map(([key, label]) => ({ key, label, rows: rows.filter(r => r.pinned && (r.region || 'other') === key) }));
  groups.push({ key: 'receipts', label: 'Also on receipts', hint: 'not chosen, but receipts use it', rows: rows.filter(r => !r.pinned) });
  return groups.filter(g => g.rows.length);
}

export default function ExchangeRates({ isAdmin, currencies = [] }) {
  const { isMobile } = useViewMode();
  const [board, setBoard] = useState(null);
  const [open, setOpen] = useState(null);         // the currency whose window is open
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState('');
  const [appId, setAppId] = useState('');
  // { at: 'board' | 'source', tone, text }
  const [note, setNote] = useState(null);

  const notify = useCallback((tone, text, at = 'board') => setNote({ tone, text, at }), []);
  const load = useCallback(() => api.get('/fx/board').then(setBoard).catch(e => notify('error', e.message)), [notify]);

  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, POLL_MS);

  // Every admin action answers with the whole board, so the screen never has
  // to guess what changed. Resolves true when it worked, so a caller clears
  // its form only then. `at` is where the answer is shown.
  async function act(label, at, fn, done) {
    setBusy(label);
    setNote(null);
    try {
      const next = await fn();
      if (next && next.rows) setBoard(next);
      if (done) notify('success', done, at);
      return true;
    } catch (e) { notify('error', e.message, at); return false; }
    finally { setBusy(''); }
  }

  if (!board) return <div className="card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>{note ? `Could not load the exchange rates: ${note.text}` : 'Loading exchange rates…'}</div>;
  const { base, timezone, source } = board;
  const groups = groupRows(board.rows);
  const openRow = open ? board.rows.find(r => r.currency === open) : null;
  const cols = isMobile ? 3 : 6;

  const openKeys = r => ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpen(r.currency); } };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div className="card-title">Exchange Rates</div>
            <div className="card-subtitle" style={{ marginBottom: 0 }}>
              Receipts are priced at the closing rate for their receipt date. Today&rsquo;s receipts use the live rate and move to
              tonight&rsquo;s close at {board.closesAt} {zoneLabel(timezone)}, unless their case has already been claimed. Choose a currency to see its chart and daily log.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={muted}>
              {board.updatedAt ? `Live · updated ${formatTime(board.updatedAt, timezone)} ${zoneLabel(timezone)}` : 'Not refreshed yet'}
            </span>
            {isAdmin && (
              <>
                <button className="btn btn-outline btn-sm" disabled={!!busy}
                        onClick={() => act('refresh', 'board', () => api.post('/fx/live/refresh', {}), 'Rates refreshed.')}>
                  {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
                </button>
                <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => setChoosing(true)}>Choose currencies</button>
              </>
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
                {!isMobile && <th style={{ textAlign: 'right' }}>Today</th>}
                {!isMobile && <th style={{ textAlign: 'right' }}>Last close</th>}
                {!isMobile && <th style={{ textAlign: 'right' }}>Receipts</th>}
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <Fragment key={g.key}>
                  <tr aria-hidden="true">
                    <td colSpan={cols} style={{ padding: '14px 14px 6px', fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)', background: 'transparent' }}>
                      {g.label}{g.hint ? <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}> · {g.hint}</span> : null}
                    </td>
                  </tr>
                  {g.rows.map(r => {
                    const drift = r.live && r.live.divergence !== null && Math.abs(r.live.divergence) > 0.01;
                    return (
                      <tr key={r.currency} onClick={() => setOpen(r.currency)} onKeyDown={openKeys(r)} tabIndex={0} role="button"
                          aria-haspopup="dialog" aria-label={`${r.currency}, ${r.name || ''}: open its chart and daily log`} style={{ cursor: 'pointer' }}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <CodeBadge code={r.currency} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: 13 }}>{r.name || r.currency}</div>
                              <div style={muted}>{r.live ? `1 ${base} = ${fmtInverse(r.inverse)} ${r.currency}` : `to ${base}`}</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {r.live ? (
                            <>
                              <div style={num} title={`${String(r.live.rate)} · ${r.live.sourceLabel}, published ${r.live.providerTime ? formatDateTime(r.live.providerTime, timezone) : fmtDay(r.live.providerDate)}`}>{fmtRate(r.live.rate)}</div>
                              {isMobile && <div style={{ ...muted, ...num }}>{fmtChange(r.change)}</div>}
                              {r.manualToday && <div style={{ ...muted, color: 'var(--text-secondary)' }}>today set at {fmtRate(r.manualToday.rate)}</div>}
                              {drift && <div style={{ fontSize: 11.5, color: 'var(--warning)' }}>providers differ by {(Math.abs(r.live.divergence) * 100).toFixed(2)}%</div>}
                            </>
                          ) : <span style={{ color: 'var(--warning)', fontSize: 12.5 }}>no rate yet</span>}
                        </td>
                        {!isMobile && <td style={{ textAlign: 'right', whiteSpace: 'nowrap', ...num, color: 'var(--text-secondary)' }}>{fmtChange(r.change)}</td>}
                        {!isMobile && (
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {r.lastClose ? (
                              <>
                                <div style={num}>{fmtRate(r.lastClose.rate)}</div>
                                <div style={muted}>{fmtDay(r.lastClose.date)}{r.lastClose.closed ? '' : ' · looked up'}</div>
                              </>
                            ) : <span style={muted}>—</span>}
                          </td>
                        )}
                        {!isMobile && <td style={{ textAlign: 'right', ...num }}>{r.receipts}</td>}
                        <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: 16 }}>›</td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
          {!board.rows.length && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              No currency on the board yet. A currency appears here as soon as a receipt in it is read{isAdmin ? ', or choose some to watch' : ''}.
            </div>
          )}
        </div>
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
                Their free plan updates hourly within 1,000 requests a month, and this board uses about 744 refreshing every {source.everyMinutes} minutes,
                however many currencies it shows.
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

      {/* Drawn at the end of <body> (components/Modal.jsx), so a card that
          lifts on hover cannot carry them with it. */}
      {openRow && (
        <CurrencyDetail key={openRow.currency} row={openRow} base={base} timezone={timezone} today={board.today}
                        isAdmin={isAdmin} onClose={() => setOpen(null)} onBoard={next => { if (next && next.rows) setBoard(next); }} />
      )}
      {choosing && (
        <ChooseCurrencies currencies={currencies} rows={board.rows} base={base} max={board.max || 10}
                          onClose={() => setChoosing(false)}
                          onSaved={next => { if (next && next.rows) { setBoard(next); notify('success', 'The board shows your chosen currencies.'); } }} />
      )}
    </div>
  );
}
