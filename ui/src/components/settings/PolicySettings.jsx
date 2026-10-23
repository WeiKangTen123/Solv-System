import { useEffect, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import { formatDateTime } from '../../utils/formatDate';
import Checkbox from '../ui/Checkbox';

// The company's policy, as an admin sets it (main/store/policy.js): the
// mileage rate, the share of a day's per diem the first and last day of a
// trip get, a limit a receipt for each category, the oldest a receipt may be,
// and whether weekend receipts are flagged. Nothing here approves or refuses
// anything: a limit, an age and a weekend only put a yellow "have a look"
// flag on a receipt, and the rates are what per diem and mileage are worked
// out at.
//
// The server checks every value and says what it takes; its words are shown
// at the box they are about, and the box takes focus, so the person reads the
// reason where it has to be fixed.
//
// Props:
//   tz  the person's time zone, for when the policy was last changed.

// Which box a refusal is about, from the server's own words (store/policy.js
// RULES). One at a time: the server stops at the first.
export function policyField(message) {
  const m = String(message || '');
  const limit = /^The limit for (.+?) must/.exec(m);
  if (limit) return `limit:${limit[1]}`;
  if (/^Not a category|category limits/i.test(m)) return 'limits';
  if (/mileage rate/i.test(m)) return 'mileageRatePerKm';
  if (/travel-day/i.test(m)) return 'travelDayPct';
  if (/maximum age/i.test(m)) return 'maxAgeDays';
  if (/weekend/i.test(m)) return 'flagWeekends';
  return null;
}

const str = v => (v === null || v === undefined ? '' : String(v));
function toForm(v) {
  const p = v.policy || {};
  const limits = p.categoryLimits || {};
  return {
    mileageRatePerKm: str(p.mileageRatePerKm),
    travelDayPct: str(p.travelDayPct),
    maxAgeDays: str(p.maxAgeDays),
    flagWeekends: !!p.flagWeekends,
    limits: Object.fromEntries((v.categories || []).map(c => [c, str(limits[c])])),
  };
}
// Blank means "none" (or, for the travel-day share, the default of 100%).
const orNull = v => (String(v).trim() === '' ? null : String(v).trim());

export default function PolicySettings({ tz }) {
  const [view, setView] = useState(null);      // GET /company/policy
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [err, setErr] = useState(null);        // { field, text } from the last Save
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef(null);

  useEffect(() => {
    let alive = true;
    api.get('/company/policy')
      .then(v => { if (alive) { setView(v); setForm(toForm(v)); } })
      .catch(e => { if (alive) setLoadError(e.message); });
    return () => { alive = false; };
  }, []);

  // The box a refusal is about takes focus, so the reason beside it is read.
  useEffect(() => {
    if (!err || !err.field || !root.current) return;
    const box = root.current.querySelector(`[data-field="${CSS.escape(err.field)}"]`);
    if (box) box.focus();
  }, [err]);

  if (loadError) return <div className="card"><div className="card-title">Policy</div><div className="alert alert-error" role="alert">{loadError}</div></div>;
  if (!view || !form) return <div className="card"><div className="card-title">Policy</div><div className="pol-muted">Loading the policy…</div></div>;

  const base = view.baseCurrency || 'SGD';
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setDone(''); };
  const setLimit = (c, v) => { setForm(f => ({ ...f, limits: { ...f.limits, [c]: v } })); setDone(''); };

  async function save(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null); setDone('');
    try {
      const v = await api.put('/company/policy', {
        mileageRatePerKm: orNull(form.mileageRatePerKm),
        travelDayPct: orNull(form.travelDayPct),
        maxAgeDays: orNull(form.maxAgeDays),
        flagWeekends: !!form.flagWeekends,
        // Every category, blank ones as null: the server merges, so a limit
        // emptied here has to be said to go.
        categoryLimits: Object.fromEntries(Object.entries(form.limits).map(([c, v]) => [c, orNull(v)])),
      });
      setView(v);
      setForm(toForm(v));
      setDone('Policy saved. Receipts shown from now on carry its flags.');
    } catch (e2) {
      setErr({ field: policyField(e2.message), text: e2.message });
    } finally { setBusy(false); }
  }

  // The props a box needs to be marked and to say what was wrong with it.
  const errFor = field => (err && err.field === field ? err.text : '');
  const boxProps = (field, id) => ({
    id, 'data-field': field,
    'aria-invalid': errFor(field) ? true : undefined,
    'aria-describedby': [`${id}-hint`, errFor(field) ? `${id}-err` : ''].filter(Boolean).join(' '),
  });
  const fieldError = (field, id) => errFor(field) && <div id={`${id}-err`} className="pol-err" role="alert">{errFor(field)}</div>;
  const changed = view.updatedAt
    ? `Last changed ${formatDateTime(view.updatedAt, tz)}${view.updatedBy && view.updatedBy.name ? ` by ${view.updatedBy.name}` : ''}.`
    : 'Not changed yet: the defaults apply.';

  return (
    <form className="card pol-card" onSubmit={save} ref={root} noValidate>
      <div className="card-title">Policy</div>
      <div className="card-subtitle">
        What per diem and mileage are worked out at, and which receipts get a yellow &ldquo;have a look&rdquo; flag.
        Nothing here stops a claim. Amounts are in {base}.
      </div>

      <div className="pol-grid">
        <div className={`form-group${errFor('mileageRatePerKm') ? ' is-invalid' : ''}`}>
          <label className="form-label" htmlFor="pol-mileage">Mileage rate per km</label>
          <div className="pol-affix">
            <span className="pol-affix-text" aria-hidden="true">{base}</span>
            <input className="form-input" type="number" inputMode="decimal" min="0" step="0.0001" placeholder="None"
                   value={form.mileageRatePerKm} onChange={e => set('mileageRatePerKm', e.target.value)} {...boxProps('mileageRatePerKm', 'pol-mileage')} />
          </div>
          <div className="pol-hint" id="pol-mileage-hint">Blank: nobody can add mileage until a rate is set.</div>
          {fieldError('mileageRatePerKm', 'pol-mileage')}
        </div>

        <div className={`form-group${errFor('travelDayPct') ? ' is-invalid' : ''}`}>
          <label className="form-label" htmlFor="pol-travel">Per diem on travel days</label>
          <div className="pol-affix is-after">
            <input className="form-input" type="number" inputMode="decimal" min="0" max="100" step="any" placeholder="100"
                   value={form.travelDayPct} onChange={e => set('travelDayPct', e.target.value)} {...boxProps('travelDayPct', 'pol-travel')} />
            <span className="pol-affix-text" aria-hidden="true">%</span>
          </div>
          <div className="pol-hint" id="pol-travel-hint">The share of a day&rsquo;s rate the first and last day of a trip get. Blank is 100%.</div>
          {fieldError('travelDayPct', 'pol-travel')}
        </div>

        <div className={`form-group${errFor('maxAgeDays') ? ' is-invalid' : ''}`}>
          <label className="form-label" htmlFor="pol-age">Maximum receipt age</label>
          <div className="pol-affix is-after">
            <input className="form-input" type="number" inputMode="numeric" min="1" max="3650" step="1" placeholder="None"
                   value={form.maxAgeDays} onChange={e => set('maxAgeDays', e.target.value)} {...boxProps('maxAgeDays', 'pol-age')} />
            <span className="pol-affix-text" aria-hidden="true">days</span>
          </div>
          <div className="pol-hint" id="pol-age-hint">An older receipt is flagged. Blank: no limit.</div>
          {fieldError('maxAgeDays', 'pol-age')}
        </div>

        <div className={`form-group pol-weekend${errFor('flagWeekends') ? ' is-invalid' : ''}`}>
          <span className="form-label" aria-hidden="true">Weekends</span>
          <Checkbox id="pol-weekend" checked={form.flagWeekends} onChange={on => set('flagWeekends', on)}>
            Flag receipts dated on a weekend
          </Checkbox>
          <div className="pol-hint" id="pol-weekend-hint">A per diem is never flagged for it.</div>
          {fieldError('flagWeekends', 'pol-weekend')}
        </div>
      </div>

      <fieldset className="pol-limits" aria-describedby="pol-limits-hint">
        <legend className="form-label">Limit a receipt, by category ({base})</legend>
        <div className="pol-hint" id="pol-limits-hint">
          A receipt over its category&rsquo;s limit is flagged; a hotel bill with a dinner on it is held to each limit by its lines. Blank: no limit.
        </div>
        {errFor('limits') && <div className="pol-err" role="alert">{errFor('limits')}</div>}
        <div className="pol-limit-grid">
          {Object.keys(form.limits).map(c => {
            const id = `pol-limit-${c.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
            const field = `limit:${c}`;
            return (
              <div key={c} className={`pol-limit${errFor(field) ? ' is-invalid' : ''}`}>
                <label htmlFor={id} className="pol-limit-name">{c}</label>
                <input className="form-input" type="number" inputMode="decimal" min="0" step="0.01" placeholder="No limit"
                       value={form.limits[c]} onChange={e => setLimit(c, e.target.value)}
                       id={id} data-field={field} aria-invalid={errFor(field) ? true : undefined}
                       aria-describedby={errFor(field) ? `${id}-err` : undefined} />
                {fieldError(field, id)}
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="pol-foot">
        <button className="btn btn-primary" type="submit" disabled={busy} aria-busy={busy}>{busy ? 'Saving…' : 'Save policy'}</button>
        <span className="pol-muted">{changed}</span>
      </div>
      {err && !err.field && <div className="alert alert-error pol-alert" role="alert">{err.text}</div>}
      {done && <div className="alert alert-success pol-alert" role="status">{done}</div>}
    </form>
  );
}
