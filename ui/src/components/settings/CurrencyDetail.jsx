import { useCallback, useEffect, useId, useState } from 'react';
import Modal from '../Modal';
import { api } from '../../api/client';
import { fmtRate } from '../../utils/format';
import { formatDateTime } from '../../utils/formatDate';
import { useVisiblePolling } from '../../utils/useVisiblePolling';
import { useViewMode } from '../../context/ViewModeContext';
import RateChart, { rangeOf } from './RateChart';
import CodeBadge from './CodeBadge';
import { KIND, num, muted, fmtInverse, fmtChange, fmtDay } from './fxFormat';

// One currency, opened from the board: its rate now, its last month or three
// as a chart, the daily log that receipts are priced from, and an admin's
// controls for setting a day's rate or taking it off the board. A window of
// its own rather than a row that unfolds under the board, which pushed the
// rest of the board off the screen and took the chart nowhere to go.

const RANGES = [[31, '1M'], [92, '3M']];
const POLL_MS = 60 * 1000;

export default function CurrencyDetail({ row, base, timezone, today, isAdmin, onClose, onBoard }) {
  const titleId = useId();
  const { isMobile } = useViewMode();
  const ccy = row.currency;
  const [log, setLog] = useState(null);
  const [days, setDays] = useState(31);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);
  const [rateForm, setRateForm] = useState({ date: '', rate: '' });

  const loadLog = useCallback(() => api.get(`/fx/log/${ccy}?limit=95`).then(setLog).catch(e => setNote({ tone: 'error', text: e.message })), [ccy]);
  useEffect(() => { loadLog(); }, [loadLog]);
  useVisiblePolling(loadLog, POLL_MS);

  // Every admin action answers with the board or reloads it; the log is read
  // again after, so the window never has to guess what changed.
  async function act(label, fn, done) {
    setBusy(label);
    setNote(null);
    try {
      await fn();
      await loadLog();
      if (done) setNote({ tone: 'success', text: done });
      return true;
    } catch (e) { setNote({ tone: 'error', text: e.message }); return false; }
    finally { setBusy(''); }
  }

  const reloadBoard = () => api.get('/fx/board').then(onBoard);
  const live = row.live;
  const entries = log && log.currency === ccy ? log.entries : [];
  const { high, low, avg } = rangeOf(entries, days, today);
  const drift = live && live.divergence !== null && Math.abs(live.divergence) > 0.01;

  return (
    <Modal onClose={onClose} busy={!!busy} maxWidth={720} sheet labelledBy={titleId}>
      {/* ── who it is, and the rate now ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <CodeBadge code={ccy} size="lg" />
          <div style={{ minWidth: 0 }}>
            <div id={titleId} style={{ fontSize: 16, fontWeight: 700 }}>{row.name || ccy} <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>to {base}</span></div>
            <div style={muted}>{row.receipts ? `${row.receipts} receipt${row.receipts === 1 ? '' : 's'} in ${ccy}` : 'No receipts in it yet'}{row.pinned ? ' · chosen for the board' : ' · on the board because receipts use it'}</div>
          </div>
        </div>
        <button type="button" onClick={onClose} disabled={!!busy} aria-label="Close"
                style={{ background: 'none', border: 'none', fontSize: 22, lineHeight: 1, color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>×</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: isMobile ? 10 : 18, flexWrap: 'wrap', marginTop: 14 }}>
        {live ? (
          <>
            <div style={{ ...num, fontSize: 24, fontWeight: 600 }} title={String(live.rate)}>{fmtRate(live.rate)}</div>
            <div style={{ ...num, fontSize: 13, color: 'var(--text-secondary)' }}>1 {base} = {fmtInverse(row.inverse)} {ccy}</div>
            <div style={{ ...num, fontSize: 13, color: 'var(--text-secondary)' }}>{fmtChange(row.change)} since the last close</div>
          </>
        ) : <div style={{ fontSize: 13, color: 'var(--warning)' }}>No live rate yet</div>}
      </div>
      {live && (
        <div style={{ ...muted, marginTop: 4 }}>
          Live · {live.sourceLabel}, published {live.providerTime ? formatDateTime(live.providerTime, timezone) : fmtDay(live.providerDate)}
          {row.lastClose ? ` · last close ${fmtRate(row.lastClose.rate)} on ${fmtDay(row.lastClose.date)}${row.lastClose.closed ? '' : ' (looked up)'}` : ''}
        </div>
      )}
      {row.manualToday && <div style={{ ...muted, color: 'var(--text-secondary)', marginTop: 2 }}>Today set by an admin at {fmtRate(row.manualToday.rate)}</div>}
      {drift && <div style={{ fontSize: 11.5, color: 'var(--warning)', marginTop: 2 }}>The two providers differ by {(Math.abs(live.divergence) * 100).toFixed(2)}% today</div>}

      {/* ── the chart ── */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <div role="group" aria-label="Range" style={{ display: 'flex', gap: 6 }}>
            {RANGES.map(([n, label]) => (
              <button key={n} type="button" className={`btn btn-sm ${days === n ? 'btn-primary' : 'btn-outline'}`} aria-pressed={days === n} onClick={() => setDays(n)}>{label}</button>
            ))}
          </div>
          {high !== null && (
            <div style={{ ...muted, ...num, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span>High {fmtRate(high)}</span><span>Low {fmtRate(low)}</span><span>Avg {fmtRate(avg)}</span>
            </div>
          )}
        </div>
        {log ? <RateChart entries={entries} days={days} today={today} currency={ccy} base={base} compact={isMobile} />
             : <div style={{ ...muted, height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading the history…</div>}
        <div style={{ ...muted, marginTop: 4 }}>Each day holds until the next is published, so a weekend shows Friday&rsquo;s rate. ◯ set by an admin · ● today, live.</div>
      </div>

      {/* ── the daily log ── */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Daily log</div>
        {!log ? <div style={muted}>Loading the daily log…</div>
          : entries.length ? (
            <div style={{ overflow: 'auto', maxHeight: isMobile ? 'none' : 260, border: '1px solid var(--border)', borderRadius: 10 }}>
              <table className="data-table" style={{ background: 'transparent', margin: 0 }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th style={{ textAlign: 'right' }}>Rate</th>
                    {!isMobile && <th style={{ textAlign: 'right' }}>1 {base} =</th>}
                    <th>Source</th>
                    {!isMobile && <th style={{ textAlign: 'right' }}>Used by</th>}
                    {isAdmin && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {entries.map(e => (
                    <tr key={e.date}>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDay(e.date)}</td>
                      <td style={{ textAlign: 'right', ...num, whiteSpace: 'nowrap' }} title={String(e.rate)}>
                        {fmtRate(e.rate)}
                        {e.overrides && <div style={muted} title={String(e.overrides.rate)}>was {fmtRate(e.overrides.rate)}</div>}
                        {isMobile && <div style={muted}>1 {base} = {fmtInverse(1 / e.rate)}</div>}
                      </td>
                      {!isMobile && <td style={{ textAlign: 'right', ...num, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{fmtInverse(1 / e.rate)} {ccy}</td>}
                      <td>
                        <div style={{ fontSize: 12.5 }}>{KIND[e.kind] || e.kind}</div>
                        <div style={muted}>
                          {e.kind === 'manual' ? (e.enteredBy || 'an admin') : e.sourceLabel}
                          {e.providerDate && e.providerDate !== e.date && e.kind !== 'manual' ? ` · priced ${fmtDay(e.providerDate)}` : ''}
                        </div>
                        {(e.notes || []).length > 0 && <div style={{ fontSize: 11.5, color: 'var(--warning)' }}>{e.notes.join('; ')}</div>}
                        {isMobile && e.usedBy > 0 && <div style={muted}>{e.usedBy} receipt{e.usedBy === 1 ? '' : 's'}</div>}
                      </td>
                      {!isMobile && <td style={{ textAlign: 'right', ...num, whiteSpace: 'nowrap' }}>{e.usedBy ? `${e.usedBy} receipt${e.usedBy === 1 ? '' : 's'}` : '—'}</td>}
                      {isAdmin && (
                        <td style={{ textAlign: 'right' }}>
                          {e.kind === 'manual' && (
                            <button className="btn btn-ghost btn-sm" disabled={!!busy}
                                    onClick={() => act('rate', () => api.delete(`/fx/rates?from=${encodeURIComponent(ccy)}&to=${encodeURIComponent(base)}&date=${encodeURIComponent(e.date)}`).then(reloadBoard), 'Rate removed. The day is priced from the providers again.')}>Remove</button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div style={muted}>No rates logged for {ccy} yet.</div>}
      </div>

      {/* ── an admin's controls ── */}
      {isAdmin && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
                onSubmit={e => {
                  e.preventDefault();
                  act('rate', () => api.post('/fx/rates', { from: ccy, date: rateForm.date, rate: Number(rateForm.rate) }).then(reloadBoard), 'Rate saved for that day.')
                    .then(ok => { if (ok) setRateForm({ date: '', rate: '' }); });
                }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Set the {ccy} rate for</span>
            <input className="form-input" type="date" style={{ maxWidth: 170 }} required value={rateForm.date}
                   onChange={e => setRateForm({ ...rateForm, date: e.target.value })} aria-label="Date" />
            <input className="form-input" type="number" step="any" min="0" style={{ maxWidth: 150 }} required
                   placeholder={live ? fmtRate(live.rate) : '0.0134'}
                   value={rateForm.rate} onChange={e => setRateForm({ ...rateForm, rate: e.target.value })} aria-label={`${base} per ${ccy}`} />
            <button className="btn btn-primary btn-sm" type="submit" disabled={!!busy}>{busy === 'rate' ? 'Saving…' : 'Save rate'}</button>
          </form>
          <div style={{ ...muted, marginTop: 6 }}>An admin&rsquo;s rate beats the providers for that day: for a monthly table, or a correction.</div>
          {row.pinned && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
              <button className="btn btn-ghost btn-sm" disabled={!!busy}
                      onClick={() => act('unwatch', () => api.delete(`/fx/watch/${ccy}`).then(onBoard)).then(ok => { if (ok) onClose(); })}>
                {row.receipts ? 'Take off the chosen list' : 'Take off the board'}
              </button>
            </div>
          )}
        </div>
      )}
      {note && <div className={`alert alert-${note.tone}`} role="status" style={{ marginTop: 12, marginBottom: 0 }}>{note.text}</div>}
    </Modal>
  );
}
