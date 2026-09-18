import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useViewMode } from '../context/ViewModeContext';
import { useAuth } from '../context/AuthContext';
import { formatDateTime } from '../utils/formatDate';
import CroppedImage from '../components/receipts/CroppedImage';
import ConfirmDialog from '../components/ConfirmDialog';
import StatusBadge from '../components/StatusBadge';
import { fmtMoney } from '../utils/format';

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
  const [group, setGroup] = useState(null);
  const [rot, setRot] = useState(0);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    const d = await api.get(`/expenses/${id}`);
    setExp(d.expense);
    setLocked(!!d.locked);
    setForm({ ...pick(d.expense), reportId: d.expense.reportId || '' });
    setLines(d.expense.lines.map(l => ({ category: l.category || '', description: l.description || '', amount: l.amount, onBehalfOf: l.onBehalfOf || '' })));
    setImageUrl(d.expense.receipt && d.imageToken ? `/api/receipts/${d.expense.receipt.id}/image?token=${encodeURIComponent(d.imageToken)}` : null);
    api.get(`/expenses/${id}/group`).then(setGroup).catch(() => setGroup(null));
  }, [id]);

  useEffect(() => { setMsg(null); load().catch(e => setMsg({ tone: 'error', text: e.message })); }, [load]);
  useEffect(() => { api.get('/company').then(d => setCategories(d.categories)).catch(() => {}); api.get('/reports').then(d => setDrafts(d.reports.filter(r => ['draft', 'rejected'].includes(r.status)))).catch(() => {}); }, []);
  useEffect(() => {
    // The image token lives five minutes; refresh it, and keep polling while the reader works.
    const t = setInterval(() => load().catch(() => {}), exp?.status === 'reading' ? 2500 : 4 * 60 * 1000);
    return () => clearInterval(t);
  }, [exp?.status, load]);

  const totalCents = cents(form.total);
  const linesCents = lines.reduce((s, l) => s + cents(l.amount), 0);
  const reconciled = lines.length > 0 && totalCents === linesCents;
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setLine = (i, k, v) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  async function save({ quiet } = {}) {
    setBusy('save');
    try {
      const body = { ...form, currency: String(form.currency || '').toUpperCase(), reportId: form.reportId || null };
      const r = await api.patch(`/expenses/${id}`, body);
      if (lines.length && (lines.length !== 1 || cents(lines[0].amount) !== cents(r.expense.total) || lines[0].category !== (r.expense.lines[0]?.category || '') || (lines[0].onBehalfOf || '') !== (r.expense.lines[0]?.onBehalfOf || '') || (lines[0].description || '') !== (r.expense.lines[0]?.description || ''))) {
        await api.put(`/expenses/${id}/lines`, { lines: lines.map(l => ({ ...l, amount: Number(l.amount), onBehalfOf: l.onBehalfOf.trim() || null })) });
      }
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
          <button className="btn btn-outline btn-sm" onClick={() => setConfirm('delete')}>Delete</button>
        </div>
      </div>

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
              <button className="btn btn-outline btn-sm" disabled={busy === 'reread' || !exp.receipt} onClick={reread}>{busy === 'reread' ? 'Reading…' : 'Re-read'}</button>
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
                  <input id={`f-${k}`} className="form-input" type={type} step={type === 'number' ? '0.01' : undefined} value={form[k] ?? ''} onChange={e => set(k, e.target.value)}
                         placeholder={k === 'purpose' ? 'Client site visit, Chakan plant' : k === 'currency' ? 'INR' : ''} />
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
            const fx = exp.lines[0] && exp.lines[0].fxRate ? exp.lines[0] : null;
            return (
              <div className="card">
                <div className="card-title">Exchange rate</div>
                {fx ? (
                  <>
                    <div style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>{exp.currency} → {baseCurrency} {fx.fxRate}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                      {fx.fxSource === 'manual'
                        ? `Entered by ${fx.fxOverrideBy || 'finance'}${fx.fxOverrideReason ? `: ${fx.fxOverrideReason}` : ''}`
                        : `${SOURCE_LABEL[fx.fxSource] || fx.fxSource} for ${fx.fxRateDate}${fx.fxFetchedAt ? ` · fetched ${formatDateTime(fx.fxFetchedAt, user?.timezone)}` : ''}`}
                    </div>
                    <div style={{ fontSize: 13, marginTop: 8, fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>= {fmtMoney(exp.baseTotal, baseCurrency)}</div>
                  </>
                ) : (
                  <div className="alert alert-warning" style={{ marginBottom: 0 }}>No rate yet for {exp.currency} on {exp.receiptDate || 'this date'}. Refresh, or enter one.</div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={refreshFx}>{busy === 'fx' ? 'Working…' : 'Refresh rate'}</button>
                  <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => setRateEdit({ rate: fx?.fxRate || '', reason: '' })}>Change rate…</button>
                </div>
                {rateEdit && (
                  <form onSubmit={submitRate} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input id="fx-rate" className="form-input" type="number" step="0.000001" min="0" style={{ maxWidth: 150 }} value={rateEdit.rate} onChange={e => setRateEdit({ ...rateEdit, rate: e.target.value })} aria-label="Rate" required />
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
                <select className="form-input" value={l.category} onChange={e => setLine(i, 'category', e.target.value)} aria-label="Category">
                  <option value="">Category…</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input className="form-input" value={l.description} placeholder="Rooms, 3 nights" onChange={e => setLine(i, 'description', e.target.value)} aria-label="Description" />
                <input className="form-input" type="number" step="0.01" value={l.amount} onChange={e => setLine(i, 'amount', e.target.value)} style={{ textAlign: 'right' }} aria-label="Amount" />
                <button className="btn btn-ghost btn-sm" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} aria-label="Remove line" title="Remove line">✕</button>
                <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={!!l.onBehalfOf} onChange={e => setLine(i, 'onBehalfOf', e.target.checked ? (l.onBehalfOf || ' ') : '')} /> paid on behalf of
                  </label>
                  {!!l.onBehalfOf && <input className="form-input" style={{ padding: '4px 8px', fontSize: 12, maxWidth: 220 }} value={l.onBehalfOf.trim()} placeholder="Colleague's name" onChange={e => setLine(i, 'onBehalfOf', e.target.value || ' ')} />}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: 12.5 }}>
              <button className="btn btn-outline btn-sm" onClick={() => setLines(ls => [...ls, { category: '', description: '', amount: Math.max(0, (totalCents - linesCents) / 100).toFixed(2), onBehalfOf: '' }])}>+ Line</button>
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
