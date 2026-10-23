import { useEffect, useId, useMemo, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import Modal from '../Modal';
import { fmtDateRange, fmtDay, fmtMoney } from '../../utils/format';
import {
  allowanceOf, countryName, guessPerDiemCountry, perDiemPreview, mileagePreview, MAX_KM,
} from '../../utils/allowances';

// Claims with no receipt behind them, added from the case page: a per diem
// for the days of a Trip, and mileage for a drive (main/reports/allowances.js).
// The person says what and the server works out how much, from the company's
// own rates; the dialogs show the sum first, from the same rates, so nothing
// added is a surprise. Each answers with the case view, which the page shows
// as it is.
//
//   AllowanceBar   the two buttons, under the case page's drop line
//   PerDiemDialog  "Add per diem": the days, the country, the rate, the total
//   MileageDialog  "Add mileage": date, from, to, km, one way or return, purpose

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// A rate per km as the server prints it: two places at least, four at most.
const rateText = n => Number(n).toFixed(Math.min(4, Math.max(2, (String(n).split('.')[1] || '').length)));
const pct = n => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

// Props:
//   report     the case.
//   onPerDiem, onMileage  open the dialogs.
//   onDetails  takes the person to the Details tab, where a Trip's dates are set.
export function AllowanceBar({ report, onPerDiem, onMileage, onDetails }) {
  const trip = report.kind === 'trip';
  const dated = !!(report.periodFrom && report.periodTo);
  return (
    <div className="al-bar" role="group" aria-label="Claims without a receipt">
      <span className="al-bar-text">No receipt for it?</span>
      <span className="al-bar-actions">
        {trip && <button type="button" className="btn btn-outline btn-sm" onClick={onPerDiem} disabled={!dated}>Add per diem</button>}
        <button type="button" className="btn btn-outline btn-sm" onClick={onMileage}>Add mileage</button>
      </span>
      {/* A per diem is the trip's days, so a trip without both ends has none
          yet; the button says why it cannot be pressed rather than vanishing. */}
      {trip && !dated && (
        <span className="al-bar-note">
          A per diem needs the trip&rsquo;s first and last day: set them in{' '}
          <button type="button" className="al-link" onClick={onDetails}>Details</button>.
        </span>
      )}
    </div>
  );
}

// ── Per diem ────────────────────────────────────────────────────────────────
// Props: report, base (the company's currency), onAdded(view, text), onClose.
export function PerDiemDialog({ report, base, onAdded, onClose }) {
  const uid = useId().replace(/:/g, '');
  const [policy, setPolicy] = useState(null);
  const [rates, setRates] = useState(null);
  const [country, setCountry] = useState(null);   // null until the rates are in
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guess = useMemo(() => guessPerDiemCountry(report, base), [report, base]);
  const had = (report.expenses || []).find(e => allowanceOf(e) === 'per_diem');

  useEffect(() => {
    let alive = true;
    Promise.all([api.get('/company/policy'), api.get('/company/per-diem-rates')])
      .then(([p, r]) => {
        if (!alive) return;
        const list = r.rates || [];
        const codes = [...new Set(list.map(x => x.country))];
        setPolicy(p);
        setRates(list);
        // What the receipts say first; the per diem the case has, when they
        // say nothing; the only country there is a rate for, failing both.
        setCountry(guess || (had && had.country) || (codes.length === 1 ? codes[0] : ''));
      })
      .catch(e => { if (alive) setLoadError(e.message); });
    return () => { alive = false; };
    // Once, when the dialog opens: the case is not changing under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The countries there are rates for, and the one the receipts point at even
  // without one, so the person sees why it cannot be priced.
  const options = useMemo(() => {
    const codes = new Set((rates || []).map(r => r.country));
    if (guess) codes.add(guess);
    if (country) codes.add(country);
    return [...codes].map(code => ({ code, name: countryName(code) || code, rated: (rates || []).some(r => r.country === code) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rates, guess, country]);

  const loaded = !!(policy && rates && country !== null);
  const plan = loaded ? perDiemPreview({ rates, country, from: report.periodFrom, to: report.periodTo, travelDayPct: policy.policy.travelDayPct }) : null;
  const ok = !!(plan && !plan.problem);

  async function add() {
    if (busy || !ok) return;
    setBusy(true); setError('');
    try {
      const d = await api.post(`/reports/${encodeURIComponent(report.id)}/per-diem`, { country });
      const e = (d.report.expenses || []).find(x => x.id === d.expenseId);
      onAdded(d, `Per diem ${had ? 'replaced' : 'added'}: ${e ? fmtMoney(e.total, e.currency) : ''} for ${countryName(country) || country}. It is already checked.`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const where = !country ? '' : country === guess ? 'Where this trip’s receipts were spent.' : 'Chosen here.';
  return (
    <Modal onClose={onClose} busy={busy} maxWidth={500} labelledBy={`${uid}-title`}>
      <div id={`${uid}-title`} className="cs-dialog-title">Add per diem</div>
      <p className="cs-dialog-text">
        An amount a day for {fmtDateRange(report.periodFrom, report.periodTo)}, at your company&rsquo;s rate for the country.
        It goes in as one claim under Meals, already checked, with no receipt.
      </p>

      {loadError ? <div className="alert alert-error" role="alert">{loadError}</div>
        : !loaded ? <div className="cs-sub">Loading the rates…</div>
        : !rates.length ? (
          <div className="alert alert-info" role="status">Your company has no per-diem rates yet. An admin adds them in Settings, under Company &amp; Policy.</div>
        ) : (
          <>
            <div className="form-group">
              <label className="form-label" htmlFor={`${uid}-country`}>Country</label>
              <select id={`${uid}-country`} className="form-input" value={country} disabled={busy}
                      onChange={e => { setCountry(e.target.value); setError(''); }} aria-describedby={`${uid}-where`}>
                {!country && <option value="">Choose a country…</option>}
                {options.map(o => <option key={o.code} value={o.code}>{o.name}{o.rated ? '' : ' (no rate)'}</option>)}
              </select>
              <div id={`${uid}-where`} className="al-hint">
                {where || 'None of the receipts in this case says where the trip was: choose the country.'}
              </div>
            </div>

            {plan && plan.problem ? (
              <div className="alert alert-warning" role="status">{plan.problem}</div>
            ) : plan && (
              <dl className="al-sum" aria-live="polite">
                <div className="al-sum-row">
                  <dt>Days</dt>
                  <dd>
                    {plan.days} day{plan.days === 1 ? '' : 's'}, {fmtDateRange(report.periodFrom, report.periodTo)}
                    {plan.share !== 100 && <div className="al-hint">{plan.days === 1 ? `At ${pct(plan.share)}, a travel day` : `First and last at ${pct(plan.share)}, as travel days`}</div>}
                  </dd>
                </div>
                <div className="al-sum-row">
                  <dt>Rate</dt>
                  <dd>
                    {plan.runs.length === 1
                      ? `${fmtMoney(plan.runs[0].amount, plan.currency)} a day`
                      : plan.runs.map(r => <div key={r.from}>{fmtMoney(r.amount, plan.currency)} a day, {fmtDateRange(r.from, r.to)}</div>)}
                  </dd>
                </div>
                <div className="al-sum-row is-total">
                  <dt>Total</dt>
                  <dd className="cs-num">{fmtMoney(plan.total, plan.currency)}</dd>
                </div>
              </dl>
            )}
            {had && <div className="al-hint al-replace">This replaces the per diem already in this case ({fmtMoney(had.total, had.currency)}).</div>}
          </>
        )}

      {error && <div className="alert alert-error al-error" role="alert">{error}</div>}
      <div className="cs-dialog-buttons">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={add} disabled={busy || !ok} aria-busy={busy}>
          {busy ? 'Adding…' : had ? 'Replace per diem' : 'Add per diem'}
        </button>
      </div>
    </Modal>
  );
}

// ── Mileage ─────────────────────────────────────────────────────────────────
// Which box a refusal is about, from the server's words (reports/allowances.js).
function mileageField(message) {
  const m = String(message || '');
  if (/day of the drive|in the future/i.test(m)) return 'date';
  if (/drive started/i.test(m)) return 'from';
  if (/drive ended/i.test(m)) return 'to';
  if (/distance/i.test(m)) return 'km';
  if (/return trip/i.test(m)) return 'returnTrip';
  if (/purpose/i.test(m)) return 'purpose';
  return null;
}

// Props: report, base, onAdded(view, text), onClose.
export function MileageDialog({ report, base, onAdded, onClose }) {
  const uid = useId().replace(/:/g, '');
  const today = localToday();
  // Today, unless the case's dates say the drive was another time: then
  // their first day, which is the likelier guess and is shown to be changed.
  const outside = (report.periodFrom && today < report.periodFrom) || (report.periodTo && today > report.periodTo);
  const [form, setForm] = useState({ date: outside && report.periodFrom && report.periodFrom <= today ? report.periodFrom : today, from: '', to: '', km: '', returnTrip: false, purpose: '' });
  const [policy, setPolicy] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);       // { field, text }

  useEffect(() => {
    let alive = true;
    api.get('/company/policy').then(p => { if (alive) setPolicy(p); }).catch(e => { if (alive) setLoadError(e.message); });
    return () => { alive = false; };
  }, []);

  const rate = policy && policy.policy ? policy.policy.mileageRatePerKm : null;
  const ccy = (policy && policy.baseCurrency) || base;
  const sum = mileagePreview({ km: form.km, returnTrip: form.returnTrip, rate });
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); if (error) setError(null); };
  const noRate = !!policy && !rate;

  async function add(e) {
    e.preventDefault();
    if (busy || !rate) return;
    setBusy(true); setError(null);
    try {
      const d = await api.post(`/reports/${encodeURIComponent(report.id)}/mileage`, {
        date: form.date, from: form.from, to: form.to, km: form.km === '' ? null : Number(form.km),
        returnTrip: !!form.returnTrip, purpose: form.purpose.trim() || null,
      });
      const x = (d.report.expenses || []).find(y => y.id === d.expenseId);
      onAdded(d, `Mileage added: ${x ? fmtMoney(x.total, x.currency) : ''} for ${form.from} to ${form.to}${form.returnTrip ? ' and back' : ''}. It is already checked.`);
    } catch (err) {
      setError({ field: mileageField(err.message), text: err.message });
      setBusy(false);
    }
  }

  // The box a refusal is about takes focus, so its reason is read there.
  useEffect(() => {
    if (!error || !error.field) return;
    const el = document.getElementById(`${uid}-${error.field}`);
    if (el) el.focus();
  }, [error, uid]);

  const errFor = f => (error && error.field === f ? error.text : '');
  const box = f => ({
    id: `${uid}-${f}`,
    'aria-invalid': errFor(f) ? true : undefined,
    'aria-describedby': errFor(f) ? `${uid}-${f}-err` : undefined,
  });
  const fieldError = f => errFor(f) && <div id={`${uid}-${f}-err`} className="pol-err" role="alert">{errFor(f)}</div>;

  return (
    <Modal onClose={onClose} busy={busy} maxWidth={520} labelledBy={`${uid}-title`}>
      <form onSubmit={add} noValidate>
        <div id={`${uid}-title`} className="cs-dialog-title">Add mileage</div>
        <p className="cs-dialog-text">
          A drive in your own vehicle, at your company&rsquo;s rate per km. It goes in as one claim under Fuel/Mileage, already checked, with no receipt.
        </p>

        {loadError && <div className="alert alert-error" role="alert">{loadError}</div>}
        {noRate && (
          <div className="alert alert-info" role="status">Your company has no mileage rate yet, so mileage cannot be added. An admin sets it in Settings, under Company &amp; Policy.</div>
        )}

        <fieldset className="al-fields" disabled={busy || noRate || !policy}>
          <legend className="sr-only">The drive</legend>
          <div className={`form-group${errFor('date') ? ' is-invalid' : ''}`}>
            <label className="form-label" htmlFor={`${uid}-date`}>Date</label>
            <input className="form-input" type="date" max={today} required value={form.date} onChange={e => set('date', e.target.value)} {...box('date')} />
            {fieldError('date')}
          </div>
          <div className={`form-group${errFor('km') ? ' is-invalid' : ''}`}>
            <label className="form-label" htmlFor={`${uid}-km`}>Distance, one way</label>
            <div className="pol-affix is-after">
              <input className="form-input" type="number" inputMode="decimal" min="0" max={MAX_KM} step="0.1" required value={form.km}
                     onChange={e => set('km', e.target.value)} {...box('km')} />
              <span className="pol-affix-text" aria-hidden="true">km</span>
            </div>
            {fieldError('km')}
          </div>
          <div className={`form-group${errFor('from') ? ' is-invalid' : ''}`}>
            <label className="form-label" htmlFor={`${uid}-from`}>From</label>
            <input className="form-input" required maxLength={120} placeholder="Office, Tai Seng" value={form.from} onChange={e => set('from', e.target.value)} {...box('from')} />
            {fieldError('from')}
          </div>
          <div className={`form-group${errFor('to') ? ' is-invalid' : ''}`}>
            <label className="form-label" htmlFor={`${uid}-to`}>To</label>
            <input className="form-input" required maxLength={120} placeholder="Client site, Tuas" value={form.to} onChange={e => set('to', e.target.value)} {...box('to')} />
            {fieldError('to')}
          </div>
          <div className={`form-group al-wide${errFor('returnTrip') ? ' is-invalid' : ''}`} role="radiogroup" aria-labelledby={`${uid}-legs`}>
            <span id={`${uid}-legs`} className="form-label">Trip</span>
            <div className="al-legs">
              <label className={`cs-pick-item${!form.returnTrip ? ' is-on' : ''}`}>
                <input type="radio" name={`${uid}-legs`} checked={!form.returnTrip} onChange={() => set('returnTrip', false)} />
                <span className="cs-pick-name">One way</span>
              </label>
              <label className={`cs-pick-item${form.returnTrip ? ' is-on' : ''}`}>
                <input type="radio" name={`${uid}-legs`} checked={form.returnTrip} onChange={() => set('returnTrip', true)} />
                <span className="cs-pick-name">Return, there and back</span>
              </label>
            </div>
            {fieldError('returnTrip')}
          </div>
          <div className={`form-group al-wide${errFor('purpose') ? ' is-invalid' : ''}`}>
            <label className="form-label" htmlFor={`${uid}-purpose`}>Purpose <span className="al-optional">optional</span></label>
            <input className="form-input" maxLength={500} placeholder="Site visit for the Tuas project" value={form.purpose} onChange={e => set('purpose', e.target.value)} {...box('purpose')} />
            {fieldError('purpose')}
          </div>
        </fieldset>

        {rate ? (
          <div className="al-sum al-sum-line" aria-live="polite">
            {sum
              ? <>{sum.km.toLocaleString('en-US', { maximumFractionDigits: 2 })} km{sum.legs === 2 ? ' × 2' : ''} × {ccy} {rateText(rate)} = <strong className="cs-num">{fmtMoney(sum.total, ccy)}</strong></>
              : <>At {ccy} {rateText(rate)} a km{form.date ? `, ${fmtDay(form.date, { withYear: true })}` : ''}.</>}
          </div>
        ) : null}

        {error && !error.field && <div className="alert alert-error al-error" role="alert">{error.text}</div>}
        <div className="cs-dialog-buttons">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !rate} aria-busy={busy}>{busy ? 'Adding…' : 'Add mileage'}</button>
        </div>
      </form>
    </Modal>
  );
}
