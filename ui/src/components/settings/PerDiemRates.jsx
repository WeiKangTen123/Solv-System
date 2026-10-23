import { useEffect, useMemo, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import { useConfirm } from '../../context/ConfirmContext';
import { useViewMode } from '../../context/ViewModeContext';
import { fmtDay, fmtMoney } from '../../utils/format';
import { countryName, countryOptions, currencyOf } from '../../utils/allowances';

// The per-diem rates an admin keeps, one per country from a date
// (main/store/policy.js). "Add per diem" on a Trip prices each day at the
// latest rate that had started by then, so a rate is never edited: the day a
// rate changes is a new rate from that date, and the days before it keep the
// old one. A mistake is deleted and added again.
//
// Props:
//   currencies  [{ code, name }] the company offers, for the currency box.
const today = () => new Date().toISOString().slice(0, 10);
const EMPTY = { country: '', currency: '', dailyAmount: '', effectiveFrom: '' };

// Which box a refusal is about, from the server's words (store/policy.js addRate).
function rateField(message) {
  const m = String(message || '');
  if (/^The country/i.test(m)) return 'country';
  if (/^The currency/i.test(m)) return 'currency';
  if (/amount a day/i.test(m)) return 'dailyAmount';
  if (/date the rate applies|already a rate/i.test(m)) return 'effectiveFrom';
  return null;
}

export default function PerDiemRates({ currencies = [] }) {
  const confirm = useConfirm();
  const { isMobile } = useViewMode();
  const [rates, setRates] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState(EMPTY);
  // The currency the form filled in by itself, so picking another country
  // changes it until the admin types one of their own.
  const [autoCcy, setAutoCcy] = useState('');
  const [err, setErr] = useState(null);         // { field, text }
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState('');
  const countries = useMemo(() => countryOptions(), []);

  useEffect(() => {
    let alive = true;
    api.get('/company/per-diem-rates')
      .then(d => { if (alive) setRates(d.rates || []); })
      .catch(e => { if (alive) setLoadError(e.message); });
    return () => { alive = false; };
  }, []);

  function pickCountry(code) {
    const ccy = currencyOf(code);
    setForm(f => ({ ...f, country: code, currency: !f.currency || f.currency === autoCcy ? ccy : f.currency }));
    setAutoCcy(ccy);
    setErr(null); setDone('');
  }
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setErr(null); setDone(''); };

  async function add(e) {
    e.preventDefault();
    if (busy) return;
    setBusy('add'); setErr(null); setDone('');
    try {
      const d = await api.post('/company/per-diem-rates', { ...form, dailyAmount: form.dailyAmount === '' ? null : form.dailyAmount });
      setRates(d.rates || []);
      const r = d.rate;
      setDone(`Added: ${countryName(r.country) || r.country}, ${fmtMoney(r.dailyAmount, r.currency)} a day from ${fmtDay(r.effectiveFrom, { withYear: true })}.`);
      setForm(EMPTY); setAutoCcy('');
    } catch (e2) {
      setErr({ field: rateField(e2.message), text: e2.message });
    } finally { setBusy(''); }
  }

  async function remove(r) {
    const name = countryName(r.country) || r.country;
    const ok = await confirm({
      title: `Delete the rate for ${name} from ${fmtDay(r.effectiveFrom, { withYear: true })}?`,
      message: `${fmtMoney(r.dailyAmount, r.currency)} a day. A per diem already added keeps its amount; one added from now on uses the rate before this one, or none.`,
      confirmLabel: 'Delete rate', danger: true,
    });
    if (!ok) return;
    setBusy(r.id); setErr(null); setDone('');
    try {
      const d = await api.delete(`/company/per-diem-rates/${encodeURIComponent(r.id)}`);
      setRates(d.rates || []);
      setDone(`Deleted the rate for ${name} from ${fmtDay(r.effectiveFrom, { withYear: true })}.`);
    } catch (e2) {
      // Gone already (another admin, another tab) is what was wanted.
      if (e2.status === 404) setRates(rs => (rs || []).filter(x => x.id !== r.id));
      else setErr({ field: null, text: e2.message });
    } finally { setBusy(''); }
  }

  // The rate in force today for each country: the latest that has started.
  // A later one is coming; an earlier one prices only the days before.
  const now = today();
  const current = new Map();
  for (const r of rates || []) {
    if (r.effectiveFrom > now) continue;
    const had = current.get(r.country);
    if (!had || r.effectiveFrom > had.effectiveFrom) current.set(r.country, r);
  }
  const standing = r => (r.effectiveFrom > now ? 'from then' : current.get(r.country) === r ? 'in force' : 'earlier days');

  const errFor = f => (err && err.field === f ? err.text : '');
  const aria = (f, id) => ({ 'aria-invalid': errFor(f) ? true : undefined, 'aria-describedby': errFor(f) ? `${id}-err` : undefined });
  const fieldError = (f, id) => errFor(f) && <div id={`${id}-err`} className="pol-err" role="alert">{errFor(f)}</div>;

  return (
    <div className="card pol-card">
      <div className="card-title">Per diem rates</div>
      <div className="card-subtitle">
        An amount a day for each country, from a date. &ldquo;Add per diem&rdquo; on a Trip pays each day at the rate in force that day.
        To change a rate, add the new one from the day it starts; the days before keep the old one.
      </div>

      {loadError ? <div className="alert alert-error" role="alert">{loadError}</div>
        : !rates ? <div className="pol-muted">Loading the rates…</div>
        : !rates.length ? <div className="pol-empty">No rates yet. Add the first below; until then nobody can add a per diem.</div>
        // A phone: a line per rate, so Delete is not scrolled off the side.
        : isMobile ? (
          <ul className="pol-rate-list">
            {rates.map(r => {
              const name = countryName(r.country) || r.countryName || r.country;
              return (
                <li key={r.id} className={`pol-rate-item${standing(r) === 'earlier days' ? ' is-past' : ''}`}>
                  <div className="pol-rate-main">
                    <div><span className="pol-country">{name}</span> <span className="pol-code">{r.country}</span></div>
                    <div className="cs-num">{fmtMoney(r.dailyAmount, r.currency)} a day</div>
                    <div className="cs-sub">From {fmtDay(r.effectiveFrom, { withYear: true })}, {standing(r)}</div>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm pol-danger" disabled={!!busy} onClick={() => remove(r)}>
                    Delete<span className="sr-only"> the rate for {name} from {fmtDay(r.effectiveFrom, { withYear: true })}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="cs-table-wrap">
            <table className="data-table pol-rates">
              <thead>
                <tr><th>Country</th><th>Currency</th><th className="cs-right">A day</th><th>From</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {rates.map(r => {
                  const name = countryName(r.country) || r.countryName || r.country;
                  return (
                    <tr key={r.id} className={standing(r) === 'earlier days' ? 'is-past' : undefined}>
                      <td><span className="pol-country">{name}</span> <span className="pol-code">{r.country}</span></td>
                      <td className="cs-mono">{r.currency}</td>
                      <td className="cs-right cs-num">{fmtMoney(r.dailyAmount, '')}</td>
                      <td className="cs-nowrap">
                        {fmtDay(r.effectiveFrom, { withYear: true })}
                        <div className="cs-sub">{standing(r)}</div>
                      </td>
                      <td className="cs-right">
                        <button type="button" className="btn btn-ghost btn-sm pol-danger" disabled={!!busy} onClick={() => remove(r)}>
                          Delete<span className="sr-only"> the rate for {name} from {fmtDay(r.effectiveFrom, { withYear: true })}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      <form className="pol-add" onSubmit={add} noValidate aria-label="Add a per diem rate">
        <div className="pol-add-title">Add a rate</div>
        <div className="pol-add-grid">
          <div className={`form-group${errFor('country') ? ' is-invalid' : ''}`}>
            <label className="form-label" htmlFor="pd-country">Country</label>
            <select id="pd-country" className="form-input" value={form.country} onChange={e => pickCountry(e.target.value)} required {...aria('country', 'pd-country')}>
              <option value="">Choose a country…</option>
              {countries.map(c => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
            </select>
            {fieldError('country', 'pd-country')}
          </div>
          <div className={`form-group${errFor('currency') ? ' is-invalid' : ''}`}>
            <label className="form-label" htmlFor="pd-ccy">Currency</label>
            <input id="pd-ccy" className="form-input cs-mono" value={form.currency} maxLength={3} placeholder="INR" list="pd-ccy-list" autoComplete="off" required
                   onChange={e => set('currency', e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))} {...aria('currency', 'pd-ccy')} />
            <datalist id="pd-ccy-list">{currencies.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</datalist>
            {fieldError('currency', 'pd-ccy')}
          </div>
          <div className={`form-group${errFor('dailyAmount') ? ' is-invalid' : ''}`}>
            <label className="form-label" htmlFor="pd-amount">Amount a day</label>
            <input id="pd-amount" className="form-input" type="number" inputMode="decimal" min="0" step="0.01" value={form.dailyAmount} required
                   onChange={e => set('dailyAmount', e.target.value)} {...aria('dailyAmount', 'pd-amount')} />
            {fieldError('dailyAmount', 'pd-amount')}
          </div>
          <div className={`form-group${errFor('effectiveFrom') ? ' is-invalid' : ''}`}>
            <label className="form-label" htmlFor="pd-from">From</label>
            <input id="pd-from" className="form-input" type="date" value={form.effectiveFrom} required
                   onChange={e => set('effectiveFrom', e.target.value)} {...aria('effectiveFrom', 'pd-from')} />
            {fieldError('effectiveFrom', 'pd-from')}
          </div>
        </div>
        <div className="pol-foot">
          <button type="submit" className="btn btn-primary" disabled={!!busy} aria-busy={busy === 'add'}>{busy === 'add' ? 'Adding…' : 'Add rate'}</button>
        </div>
        {err && !err.field && <div className="alert alert-error pol-alert" role="alert">{err.text}</div>}
        {done && <div className="alert alert-success pol-alert" role="status">{done}</div>}
      </form>
    </div>
  );
}
