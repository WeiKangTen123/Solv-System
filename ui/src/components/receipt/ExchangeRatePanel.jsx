import { useState } from 'react';
import { fmtMoney, fmtRate } from '../../utils/format';
import { formatDateTime } from '../../utils/formatDate';
import { fxSourceLong } from '../../utils/fxSources';

// The rate a foreign receipt was converted at, where it came from, and the
// two ways to change it: ask the providers again, or type the rate from a
// card statement with a reason. Nothing is drawn for a receipt in the base
// currency.
//
// The page makes the calls, because both save what is typed first:
//   onRefresh()                 POST /expenses/:id/fx
//   onSetRate({ rate, reason }) PATCH /expenses/:id/fx; resolves true once
//                               the rate is taken, which closes the form.
//
// Props: expense (as saved), baseCurrency, tz (the person's time zone, for
// "fetched at"), busy (a call is running; 'fx' is this panel's), disabled
// (the details cannot be changed), compact (no card of its own, for a panel
// that is already one).
export default function ExchangeRatePanel({ expense, baseCurrency, tz, busy, disabled, onRefresh, onSetRate, compact = false }) {
  const [rateEdit, setRateEdit] = useState(null);
  const exp = expense;
  if (!exp || !exp.currency || exp.currency === baseCurrency) return null;
  const l0 = (exp.lines || [])[0] || null;
  const fx = l0 && l0.fxRate ? l0 : null;

  async function submit(ev) {
    ev.preventDefault();
    if (await onSetRate({ rate: Number(rateEdit.rate), reason: rateEdit.reason })) setRateEdit(null);
  }

  return (
    <div className={compact ? 'rcpt-rate' : 'card'}>
      <div className={compact ? 'rcpt-section-title' : 'card-title'}>Exchange rate</div>
      {fx ? (
        <>
          <div className="rcpt-rate-figure">{exp.currency} → {baseCurrency} {fmtRate(fx.fxRate)}</div>
          <div className="rcpt-rate-source">
            {fx.fxSource === 'manual'
              ? `Entered by ${fx.fxOverrideBy || 'an admin'}${fx.fxOverrideReason ? `: ${fx.fxOverrideReason}` : ''}`
              : `${fxSourceLong(fx.fxSource)} for ${fx.fxRateDate}${fx.fxFetchedAt ? ` · fetched ${formatDateTime(fx.fxFetchedAt, tz)}` : ''}`}
          </div>
          <div className="rcpt-rate-base">= {fmtMoney(exp.baseTotal, baseCurrency)}</div>
          {fx.fxNotOnTheDay && (
            <div className="alert alert-warning" style={{ marginTop: 10, marginBottom: 0 }}>
              This rate is from {fx.fxRateDate}, not {fx.fxAskedDate}. No rate is published for {exp.currency} on the receipt's date, so the day's rate was used. Enter the rate from your card statement if you have it.
            </div>
          )}
          {fx.fxCheck && <div className="alert alert-warning" style={{ marginTop: 10, marginBottom: 0 }}>{fx.fxCheck}</div>}
        </>
      ) : (
        <div className="alert alert-warning" style={{ marginBottom: 0 }}>
          {l0 && l0.fxCheck
            ? `${l0.fxCheck} Until then this receipt has no converted amount.`
            : `No rate yet for ${exp.currency} on ${exp.receiptDate || 'this date'}. Refresh, or enter one.`}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-outline btn-sm" disabled={!!busy || disabled} onClick={onRefresh}>{busy === 'fx' ? 'Working…' : 'Refresh rate'}</button>
        <button type="button" className="btn btn-outline btn-sm" disabled={!!busy || disabled} onClick={() => setRateEdit({ rate: fx?.fxRate || '', reason: '' })}>Change rate…</button>
      </div>
      {rateEdit && (
        <form onSubmit={submit} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="form-input" type="number" step="any" min="0" style={{ maxWidth: 150 }} value={rateEdit.rate} onChange={e => setRateEdit({ ...rateEdit, rate: e.target.value })} aria-label="Rate" required />
          <input className="form-input" style={{ flex: 1, minWidth: 180 }} placeholder="Why (e.g. card statement rate)" value={rateEdit.reason} onChange={e => setRateEdit({ ...rateEdit, reason: e.target.value })} aria-label="Reason" required />
          <button className="btn btn-primary btn-sm" type="submit" disabled={!!busy}>Use this rate</button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRateEdit(null)}>Cancel</button>
        </form>
      )}
    </div>
  );
}
