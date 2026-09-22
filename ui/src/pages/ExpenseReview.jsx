import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useViewMode } from '../context/ViewModeContext';
import { useAuth } from '../context/AuthContext';
import { formatDateTime } from '../utils/formatDate';
import CroppedImage from '../components/receipts/CroppedImage';
import ConfirmDialog from '../components/ConfirmDialog';
import StatusBadge from '../components/StatusBadge';
import { fmtMoney, fmtRate } from '../utils/format';

// Image on the left, fields on the right, so a figure is checked against the
// receipt without switching context. Below the fields, the split into report
// lines, which must add up to the total before the expense can be reviewed.
const FIELDS = [
  ['merchant', 'Merchant', 'text'], ['receiptDate', 'Receipt date', 'date'], ['receiptTime', 'Time', 'text'], ['invoiceNo', 'Invoice no.', 'text'],
  ['currency', 'Currency', 'text'], ['total', 'Total', 'number'], ['tax', 'Tax included', 'number'], ['purpose', 'Business purpose', 'text'],
];
const SOURCE_LABEL = { frankfurter: 'European Central Bank reference rate', 'open.er-api': 'ExchangeRate-API daily rate', base: 'Base currency', same: 'Same currency' };
const pick = e => Object.fromEntries(FIELDS.map(([k]) => [k, e[k] ?? '']));
const cents = v => Math.round(Number(v || 0) * 100);

export default function ExpenseReview() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isMobile } = useViewMode();
  const { user } = useAuth();
  const baseCurrency = user?.baseCurrency || 'SGD';
  const [exp, setExp] = useState(null);
  const [rateEdit, setRateEdit] = useState(null);
  const [locked, setLocked] = useState(false);
  const [drafts, setDrafts] = useState([]);
  const [imageUrl, setImageUrl] = useState(null);
  const [form, setForm] = useState({});
  const [lines, setLines] = useState([]);
  const [categories, setCategories] = useState([]);
  const [currencies, setCurrencies] = useState([]);
  const [group, setGroup] = useState(null);
  const [rot, setRot] = useState(0);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [confirm, setConfirm] = useState(null);

  // Set as soon as the user touches a field, cleared by a save or a reload
  // they asked for. The poll below runs every 2.5s while the reader works, and
  // without this it overwrote whatever was being typed at the time.
  const dirty = useRef(false);

  const load = useCallback(async ({ preserveEdits } = {}) => {
    const d = await api.get(`/expenses/${id}`);
    setExp(d.expense);
    setLocked(!!d.locked);
    if (!(preserveEdits && dirty.current)) {
      setForm({ ...pick(d.expense), reportId: d.expense.reportId || '' });
      setLines(d.expense.lines.map(l => ({ category: l.category || '', description: l.description || '', amount: l.amount, onBehalfOf: l.onBehalfOf || '' })));
      dirty.current = false;
    }
    setImageUrl(d.expense.receipt && d.imageToken ? `/api/receipts/${d.expense.receipt.id}/image?token=${encodeURIComponent(d.imageToken)}` : null);
    api.get(`/expenses/${id}/group`).then(setGroup).catch(() => setGroup(null));
  }, [id]);

  useEffect(() => { setMsg(null); load().catch(e => setMsg({ tone: 'error', text: e.message })); }, [load]);
  useEffect(() => { api.get('/company').then(d => { setCategories(d.categories); setCurrencies(d.currencies || []); }).catch(() => {}); api.get('/reports').then(d => setDrafts(d.reports.filter(r => ['draft', 'rejected'].includes(r.status)))).catch(() => {}); }, []);
  useEffect(() => {
    // The image token lives five minutes; refresh it, and keep polling while the reader works.
    const t = setInterval(() => load({ preserveEdits: true }).catch(() => {}), exp?.status === 'reading' ? 2500 : 4 * 60 * 1000);
    return () => clearInterval(t);
  }, [exp?.status, load]);

  const totalCents = cents(form.total);
  const linesCents = lines.reduce((s, l) => s + cents(l.amount), 0);
  const reconciled = lines.length > 0 && totalCents === linesCents;
  const set = (k, v) => { dirty.current = true; setForm(f => ({ ...f, [k]: v })); };
  const setLine = (i, k, v) => { dirty.current = true; setLines(ls => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l))); };
  const editLines = fn => { dirty.current = true; setLines(fn); };

  async function save({ quiet } = {}) {
    setBusy('save');
    try {
      const body = { ...form, currency: String(form.currency || '').toUpperCase(), reportId: form.reportId || null };
      const r = await api.patch(`/expenses/${id}`, body);
      if (lines.length && (lines.length !== 1 || cents(lines[0].amount) !== cents(r.expense.total) || lines[0].category !== (r.expense.lines[0]?.category || '') || (lines[0].onBehalfOf || '') !== (r.expense.lines[0]?.onBehalfOf || '') || (lines[0].description || '') !== (r.expense.lines[0]?.description || ''))) {
        await api.put(`/expenses/${id}/lines`, { lines: lines.map(l => ({ ...l, amount: Number(l.amount), onBehalfOf: l.onBehalfOf.trim() || null })) });
      }
      dirty.current = false;
      await load();
      if (!quiet) setMsg({ tone: 'success', text: 'Saved.' });
      return true;
    } catch (e) { setMsg({ tone: 'error', text: e.message }); return false; }
    finally { setBusy(''); }
  }
  async function markReviewed() {
    if (!(await save({ quiet: true }))) return;
    setBusy('review');
    try {
      await api.patch(`/expenses/${id}/status`, { status: 'reviewed' });
      const next = group?.siblings?.find(s => s.id !== id && s.status !== 'reviewed');
      if (next) navigate(`/expenses/${next.id}`); else { await load(); setMsg({ tone: 'success', text: 'Marked reviewed.' }); }
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(''); }
  }
  async function reread() {
    setBusy('reread');
    try {
      const r = await api.post(`/expenses/${id}/reread`, {});
      await load();
      setMsg(r.ok ? { tone: 'success', text: `Read again (${r.confidence} confidence).` } : { tone: 'warning', text: 'The reader could not make out this receipt. Type the fields by hand.' });
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(''); }
  }
  async function refreshFx() {
    if (!(await save({ quiet: true }))) return;
    setBusy('fx');
    try { const out = await api.post(`/expenses/${id}/fx`, {}); await load(); setMsg(out.pending ? { tone: 'warning', text: `No rate found for ${exp.currency} on that date.` } : { tone: 'success', text: 'Rate refreshed.' }); }
    catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(''); }
  }
  async function submitRate(ev) {
    ev.preventDefault();
    if (!(await save({ quiet: true }))) return;
    setBusy('fx');
    try { await api.patch(`/expenses/${id}/fx`, { rate: Number(rateEdit.rate), reason: rateEdit.reason }); setRateEdit(null); await load(); setMsg({ tone: 'success', text: 'Rate changed.' }); }
    catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(''); }
  }
  async function remove() {
    setConfirm(null);
    try { await api.delete(`/expenses/${id}`); navigate('/expenses'); } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  }

  if (!exp) return <div style={{ color: 'var(--text-muted)' }}>{msg?.text || 'Loading…'}</div>;
  const isPdf = exp.receipt?.mime === 'application/pdf';
  const idx = group?.siblings?.findIndex(s => s.id === id) ?? -1;
  const prev = idx > 0 ? group.siblings[idx - 1] : null;
  const next = idx >= 0 && idx < (group?.siblings?.length || 0) - 1 ? group.siblings[idx + 1] : null;

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}><Link to="/expenses" style={{ color: 'inherit' }}>← My expenses</Link></div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{exp.merchant || 'Untitled receipt'} <StatusBadge status={exp.status} /></h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {prev && <button className="btn btn-outline btn-sm" onClick={() => navigate(`/expenses/${prev.id}`)}>← Prev</button>}
          {next && <button className="btn btn-outline btn-sm" onClick={() => navigate(`/expenses/${next.id}`)}>Next →</button>}
          <button className="btn btn-outline btn-sm" disabled={locked} title={locked ? 'The report it is in has been submitted' : ''} onClick={() => setConfirm('delete')}>Delete</button>
        </div>
      </div>

      {/* Offered, not enforced: any three-letter code still works, because the
          rate providers cover far more currencies than anyone would list. */}
      <datalist id="currency-options">
        {currencies.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
      </datalist>

      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}
      {locked && <div className="alert alert-info">This expense is in a report that has been submitted. It can be changed again if the report is sent back.</div>}
      {exp.errorMsg && <div className="alert alert-warning"><span className="alert-icon">!</span><span>{exp.errorMsg}{exp.duplicateOf && <> · <Link to={`/expenses/${exp.duplicateOf}`}>see the other one</Link></>}</span></div>}
      {group?.split && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>{group.groupType === 'batch' ? 'Batch import' : 'Split from one file'} · {group.index} of {group.total}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) 460px', gap: 20, alignItems: 'start' }}>
        {/* Receipt */}
        <div className="card" style={{ padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {exp.receipt ? `${isPdf ? 'PDF' : 'Photo'}${exp.receipt.pages ? ` · ${exp.receipt.pages} page${exp.receipt.pages === 1 ? '' : 's'}` : ''}${exp.page ? ` · page ${exp.page}` : ''}` : 'No file'}
              {exp.aiReadAt && ` · read by AI, ${exp.aiConfidence || 'low'} confidence`}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {!isPdf && <button className="btn btn-outline btn-sm" onClick={() => setRot(r => (r + 90) % 360)}>Rotate</button>}
              <button className="btn btn-outline btn-sm" disabled={busy === 'reread' || !exp.receipt || locked} onClick={reread}>{busy === 'reread' ? 'Reading…' : 'Re-read'}</button>
              {imageUrl && <a className="btn btn-outline btn-sm" href={imageUrl} target="_blank" rel="noopener noreferrer">Open original</a>}
            </div>
          </div>
          {!imageUrl ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No receipt file.</div>
            : isPdf ? <iframe title="Receipt" src={`${imageUrl}#page=${exp.page || 1}&zoom=page-width`} style={{ width: '100%', height: isMobile ? 480 : 760, border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
            : <div style={{ overflow: 'auto', maxHeight: 760 }}><CroppedImage src={imageUrl} box={exp.box} alt="Receipt" style={{ maxWidth: '100%', transform: `rotate(${rot}deg)`, transition: 'transform .2s ease' }} /></div>}
        </div>

        {/* Fields */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-title">Receipt details</div>
            <div className="card-subtitle">Read from the receipt. Check each one, then say what it was for.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
              {FIELDS.map(([k, label, type]) => (
                <div className="form-group" key={k} style={{ gridColumn: k === 'merchant' || k === 'purpose' ? '1 / -1' : 'auto' }}>
                  <label className="form-label" htmlFor={`f-${k}`}>{label}</label>
                  <input id={`f-${k}`} className="form-input" type={type} step={type === 'number' ? '0.01' : undefined} value={form[k] ?? ''} disabled={locked}
                         list={k === 'currency' ? 'currency-options' : undefined}
                         onChange={e => set(k, k === 'currency' ? e.target.value.toUpperCase().slice(0, 3) : e.target.value)}
                         placeholder={k === 'purpose' ? 'Client site visit, Chakan plant' : k === 'currency' ? 'IDR' : ''} />
                  {k === 'currency' && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {currencies.find(c => c.code === form.currency)?.name || 'Pick one, or type any three-letter code'}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="f-report">Report</label>
              <select id="f-report" className="form-input" value={form.reportId || ''} onChange={e => set('reportId', e.target.value)} disabled={locked}>
                <option value="">Not filed yet</option>
                {drafts.map(r => <option key={r.id} value={r.id}>{r.number} {r.title || ''}</option>)}
              </select>
            </div>
            {exp.description && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reader's note: {exp.description}</div>}
          </div>

          {exp.currency && exp.currency !== baseCurrency && (() => {
            const l0 = exp.lines[0] || null;
            const fx = l0 && l0.fxRate ? l0 : null;
            return (
              <div className="card">
                <div className="card-title">Exchange rate</div>
                {fx ? (
                  <>
                    <div style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>{exp.currency} → {baseCurrency} {fmtRate(fx.fxRate)}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                      {fx.fxSource === 'manual'
                        ? `Entered by ${fx.fxOverrideBy || 'finance'}${fx.fxOverrideReason ? `: ${fx.fxOverrideReason}` : ''}`
                        : `${SOURCE_LABEL[fx.fxSource] || fx.fxSource} for ${fx.fxRateDate}${fx.fxFetchedAt ? ` · fetched ${formatDateTime(fx.fxFetchedAt, user?.timezone)}` : ''}`}
                    </div>
                    <div style={{ fontSize: 13, marginTop: 8, fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>= {fmtMoney(exp.baseTotal, baseCurrency)}</div>
                    {fx.fxNotOnTheDay && (
                      <div className="alert alert-warning" style={{ marginTop: 10, marginBottom: 0 }}>
                        This rate is from {fx.fxRateDate}, not {fx.fxAskedDate}. No rate is published for {exp.currency} on the receipt's date, so the day's rate was used. Enter the rate from your card statement if you have it.
                      </div>
                    )}
                    {fx.fxCheck && (
                      <div className="alert alert-warning" style={{ marginTop: 10, marginBottom: 0 }}>{fx.fxCheck}</div>
                    )}
                  </>
                ) : (
                  <div className="alert alert-warning" style={{ marginBottom: 0 }}>
                    {l0 && l0.fxCheck
                      ? `${l0.fxCheck} Until then this expense has no converted amount.`
                      : `No rate yet for ${exp.currency} on ${exp.receiptDate || 'this date'}. Refresh, or enter one.`}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button className="btn btn-outline btn-sm" disabled={!!busy || locked} onClick={refreshFx}>{busy === 'fx' ? 'Working…' : 'Refresh rate'}</button>
                  <button className="btn btn-outline btn-sm" disabled={!!busy || locked} onClick={() => setRateEdit({ rate: fx?.fxRate || '', reason: '' })}>Change rate…</button>
                </div>
                {rateEdit && (
                  <form onSubmit={submitRate} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input id="fx-rate" className="form-input" type="number" step="any" min="0" style={{ maxWidth: 150 }} value={rateEdit.rate} onChange={e => setRateEdit({ ...rateEdit, rate: e.target.value })} aria-label="Rate" required />
                    <input id="fx-reason" className="form-input" style={{ flex: 1, minWidth: 180 }} placeholder="Why (e.g. card statement rate)" value={rateEdit.reason} onChange={e => setRateEdit({ ...rateEdit, reason: e.target.value })} aria-label="Reason" required />
                    <button className="btn btn-primary btn-sm" type="submit" disabled={!!busy}>Use this rate</button>
                    <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRateEdit(null)}>Cancel</button>
                  </form>
                )}
              </div>
            );
          })()}

          <div className="card">
            <div className="card-title">Lines</div>
            <div className="card-subtitle">One line per category on the report. They must add up to the total{form.currency ? ` in ${form.currency}` : ''}.</div>
            {lines.map((l, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.4fr 0.9fr auto', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <select className="form-input" value={l.category} disabled={locked} onChange={e => setLine(i, 'category', e.target.value)} aria-label="Category">
                  <option value="">Category…</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input className="form-input" value={l.description} placeholder="Rooms, 3 nights" disabled={locked} onChange={e => setLine(i, 'description', e.target.value)} aria-label="Description" />
                <input className="form-input" type="number" step="0.01" value={l.amount} disabled={locked} onChange={e => setLine(i, 'amount', e.target.value)} style={{ textAlign: 'right' }} aria-label="Amount" />
                <button className="btn btn-ghost btn-sm" disabled={locked} onClick={() => editLines(ls => ls.filter((_, j) => j !== i))} aria-label="Remove line" title="Remove line">✕</button>
                <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={!!l.onBehalfOf} disabled={locked} onChange={e => setLine(i, 'onBehalfOf', e.target.checked ? (l.onBehalfOf || ' ') : '')} /> paid on behalf of
                  </label>
                  {!!l.onBehalfOf && <input className="form-input" style={{ padding: '4px 8px', fontSize: 12, maxWidth: 220 }} value={l.onBehalfOf.trim()} disabled={locked} placeholder="Colleague's name" onChange={e => setLine(i, 'onBehalfOf', e.target.value || ' ')} />}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: 12.5 }}>
              <button className="btn btn-outline btn-sm" disabled={locked} onClick={() => editLines(ls => [...ls, { category: '', description: '', amount: Math.max(0, (totalCents - linesCents) / 100).toFixed(2), onBehalfOf: '' }])}>+ Line</button>
              <span style={{ color: reconciled ? 'var(--success)' : 'var(--danger)', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>
                lines {fmtMoney(linesCents / 100, form.currency)} {reconciled ? '✓' : `≠ total ${fmtMoney(totalCents / 100, form.currency)}`}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button className="btn btn-outline" disabled={!!busy || locked} onClick={() => save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            <button className="btn btn-primary" disabled={!!busy || !reconciled || locked || exp.status === 'reviewed'} title={reconciled ? '' : 'The lines must add up to the total first'} onClick={markReviewed}>
              {busy === 'review' ? 'Saving…' : (next ? 'Mark reviewed → next' : 'Mark reviewed')}
            </button>
          </div>
        </div>
      </div>

      {confirm === 'delete' && (
        <ConfirmDialog title="Delete this expense?" message="The receipt file goes with it unless another expense still uses it." confirmLabel="Delete" danger onConfirm={remove} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
