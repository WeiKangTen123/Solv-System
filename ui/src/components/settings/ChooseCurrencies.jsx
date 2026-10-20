import { useId, useState } from 'react';
import Modal from '../Modal';
import { api } from '../../api/client';
import { REGIONS } from './fxFormat';

// The currencies an admin keeps on the board, up to `max`, chosen by region.
// Currencies receipts use are on the board whatever is chosen here, because
// those are the ones being priced; this list is for the ones worth watching.
export default function ChooseCurrencies({ currencies, rows, base, max = 10, onClose, onSaved }) {
  const titleId = useId();
  const [picked, setPicked] = useState(() => new Set(rows.filter(r => r.pinned).map(r => r.currency)));
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The offered list, by region, the company's own left out; anything chosen
  // or on receipts that the list does not name is offered under Other.
  const offered = currencies.filter(c => c.code !== base);
  const known = new Set(offered.map(c => c.code));
  const extra = [...new Set([...picked, ...rows.map(r => r.currency)])].filter(c => !known.has(c) && c !== base).sort()
    .map(code => ({ code, name: (rows.find(r => r.currency === code) || {}).name || code, region: 'other' }));
  const byRegion = REGIONS.map(([key, label]) => [key, label, [...offered, ...extra].filter(c => (c.region || 'other') === key)]);
  const onReceipts = new Set(rows.filter(r => r.receipts > 0).map(r => r.currency));
  const full = picked.size >= max;

  function toggle(code) {
    setError(null);
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else if (next.size < max) next.add(code);
      return next;
    });
  }

  function addOther(e) {
    e.preventDefault();
    const code = other.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) { setError('A currency code is three letters, like CZK.'); return; }
    if (code === base) { setError(`${code} is the company's own currency.`); return; }
    if (!picked.has(code) && full) { setError(`Ten at most. Take one off first.`); return; }
    setPicked(prev => new Set(prev).add(code));
    setOther('');
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.put('/fx/watch', { currencies: [...picked] }));
      onClose();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} busy={busy} maxWidth={560} sheet labelledBy={titleId}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div id={titleId} style={{ fontSize: 16, fontWeight: 700 }}>Currencies on the board</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
            {picked.size} of {max} chosen. Currencies your receipts use stay on the board anyway.
          </div>
        </div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
                style={{ background: 'none', border: 'none', fontSize: 22, lineHeight: 1, color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>×</button>
      </div>

      {byRegion.filter(([, , list]) => list.length).map(([key, label, list]) => (
        <fieldset key={key} style={{ border: 'none', padding: 0, margin: '16px 0 0' }}>
          <legend style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>{label}</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {list.map(c => {
              const on = picked.has(c.code);
              const disabled = busy || (!on && full);
              return (
                <label key={c.code} title={`${c.name}${onReceipts.has(c.code) ? ' · used by receipts' : ''}`}
                       style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, cursor: disabled ? 'default' : 'pointer',
                                border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--bg-hover)' : 'transparent',
                                opacity: disabled && !on ? 0.5 : 1, fontSize: 12.5 }}>
                  <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(c.code)} style={{ margin: 0 }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{c.code}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{c.name}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}

      <form onSubmit={addOther} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Another code</span>
        <input className="form-input" style={{ maxWidth: 110 }} placeholder="e.g. CZK" maxLength={3} value={other}
               onChange={e => setOther(e.target.value.toUpperCase().slice(0, 3))} aria-label="Another currency code" />
        <button className="btn btn-outline btn-sm" type="submit" disabled={busy || other.length !== 3}>Add</button>
      </form>

      {error && <div className="alert alert-error" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button className="btn btn-outline" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}
