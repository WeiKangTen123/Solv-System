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
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { getCompany } from '../utils/useCompany';
import { fxSourceLong } from '../utils/fxSources';
import { useLeaveGuard } from '../utils/useLeaveGuard';

// Image on the left, fields on the right, so a figure is checked against the
// receipt without switching context. Below the fields, the split into report
// lines, which must add up to the total before the expense can be reviewed.
const FIELDS = [
  ['merchant', 'Merchant', 'text'], ['receiptDate', 'Receipt date', 'date'], ['receiptTime', 'Time', 'text'], ['invoiceNo', 'Invoice no.', 'text'],
  ['currency', 'Currency', 'text'], ['total', 'Total', 'number'], ['tax', 'Tax included', 'number'], ['purpose', 'Business purpose', 'text'],
];
const pick = e => Object.fromEntries(FIELDS.map(([k]) => [k, e[k] ?? '']));
const cents = v => Math.round(Number(v || 0) * 100);
// The lines as the server would store them, to tell whether they were edited.
const sameLines = ls => JSON.stringify(ls.map(l => [l.category || '', l.description || '', cents(l.amount), String(l.onBehalfOf || '').trim()]));

export default function ExpenseReview() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isMobile } = useViewMode();
  const { user } = useAuth();
  const baseCurrency = user?.baseCurrency || 'SGD';
  const [exp, setExp] = useState(null);
  const [rateEdit, setRateEdit] = useState(null);
  const [locked, setLocked] = useState(false);
  // What the server says this person may do here: correct the details (the
  // owner or an admin, until the case is in Xero) and act on the claim (the
  // owner, while the case is open).
  const [perm, setPerm] = useState({});
  const [history, setHistory] = useState(null);
  const [allHistory, setAllHistory] = useState(false);
  const [cases, setCases] = useState([]);
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

  // The receipt on screen, and when its link was issued. The link is kept for
  // four of its five minutes: renewing it on every poll made the browser
  // download the whole receipt again every two and a half seconds.
  const image = useRef({ receiptId: null, at: 0 });
  // The id this page is showing now. A reply for another one — a poll still in
  // flight when Prev or Next was pressed — is dropped rather than painted over
  // the new receipt, where Save would then have written it.
  const current = useRef(id);
  // What the fields said when they were loaded. Save sends only what differs:
  // sending every field wrote back blanks for anything that had changed on
  // the server since, such as what the reader filled in a moment later.
  const baseline = useRef({ form: {}, lines: '[]', raw: [] });
  // Prev, Next, a link, the browser's back button or closing the tab: any of
  // them asks first while something typed has not been saved.
  const leaveDialog = useLeaveGuard(() => dirty.current, 'What you typed on this receipt has not been saved.');
  // The number and title of the case this receipt is in, when the list of
  // cases below does not have it: a claimed case, or anyone else's.
  const [caseHead, setCaseHead] = useState(null);

  const load = useCallback(async ({ preserveEdits } = {}) => {
    const asked = id;
    const d = await api.get(`/expenses/${asked}`);
    if (current.current !== asked) return;
    setExp(d.expense);
    setLocked(!!d.locked);
    setPerm({ isOwner: !!d.isOwner, canEditDetails: !!d.canEditDetails, canAct: !!d.canAct, posted: !!d.posted });
    if (!(preserveEdits && dirty.current)) {
      const f = { ...pick(d.expense), reportId: d.expense.reportId || '' };
      const ls = d.expense.lines.map(l => ({ category: l.category || '', description: l.description || '', amount: l.amount, onBehalfOf: l.onBehalfOf || '' }));
      setForm(f); setLines(ls);
      baseline.current = { form: f, lines: sameLines(ls), raw: ls };
      dirty.current = false;
    }
    const rid = d.expense.receipt ? d.expense.receipt.id : null;
    // The picture on screen stays as it is: renewing its link reloaded the
    // PDF (losing scroll and zoom) and downloaded the photo again every few
    // minutes. Open original asks for a fresh link when it is pressed.
    if (!rid || !d.imageToken) { image.current = { receiptId: null, at: 0 }; setImageUrl(null); }
    else if (image.current.receiptId !== rid) {
      image.current = { receiptId: rid, at: Date.now() };
      setImageUrl(`/api/receipts/${rid}/image?token=${encodeURIComponent(d.imageToken)}`);
    }
  }, [id]);
  const loadHistory = useCallback(async () => {
    const asked = id;
    const d = await api.get(`/expenses/${asked}/changes`);
    if (current.current === asked) setHistory(d.changes || []);
  }, [id]);

  // A different receipt is a fresh page: nothing from the last one carries over.
  useEffect(() => {
    current.current = id;
    dirty.current = false;
    image.current = { receiptId: null, at: 0 };
    setExp(null); setGroup(null); setRot(0); setRateEdit(null); setConfirm(null); setMsg(null); setHistory(null); setAllHistory(false);
    load().catch(e => setMsg({ tone: 'error', text: e.message }));
    loadHistory().catch(() => setHistory([]));
    api.get(`/expenses/${id}/group`).then(g => { if (current.current === id) setGroup(g); }).catch(() => setGroup(null));
  }, [id, load, loadHistory]);
  // Every case in the company for an admin, the person's own for anyone else
  // (the server answers scope=all with your own unless you are an admin).
  // Which of them may take this receipt is decided at render, once the
  // expense and its owner are known.
  useEffect(() => { getCompany().then(d => { setCategories(d.categories); setCurrencies(d.currencies || []); }).catch(() => {}); }, []);
  // The cases this receipt could be filed in: its owner's open ones. Only the
  // owner files, so nobody else needs the list; an admin's page used to fetch
  // every case in the company to fill a box it could not use.
  useEffect(() => {
    if (!perm.isOwner) { setCases([]); return; }
    api.get('/reports?status=open').then(d => setCases(d.reports || [])).catch(() => {});
  }, [perm.isOwner, id]);
  // The case it is in, named. A claimed case is not among the open ones, and
  // an admin has no list at all, so the box used to read "Its case".
  const inCase = exp?.reportId || null;
  const caseListed = !!inCase && cases.some(r => r.id === inCase);
  useEffect(() => {
    setCaseHead(null);
    if (!inCase || caseListed) return undefined;
    let alive = true;
    api.get(`/reports/${inCase}`)
      .then(d => { if (alive && d.report) setCaseHead({ id: d.report.id, number: d.report.number, title: d.report.title }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [inCase, caseListed]);
  // Quickly while the reader works, slowly after; and not at all in a tab
  // nobody is looking at.
  useVisiblePolling(() => load({ preserveEdits: true }).catch(() => {}), () => (exp?.status === 'reading' ? 2500 : 4 * 60 * 1000));
  // A change applied from the assistant to this receipt shows straight away,
  // unless the fields are being typed into.
  useEffect(() => {
    const on = ev => {
      const changed = ev.detail && ev.detail.expenseId;
      if (changed && changed !== current.current) return;
      load({ preserveEdits: true }).catch(() => {});
      loadHistory().catch(() => {});
    };
    window.addEventListener('solv:changed', on);
    return () => window.removeEventListener('solv:changed', on);
  }, [load, loadHistory]);

  const totalCents = cents(form.total);
  const linesCents = lines.reduce((s, l) => s + cents(l.amount), 0);
  const reconciled = lines.length > 0 && totalCents === linesCents;
  const set = (k, v) => {
    dirty.current = true;
    setForm(f => ({ ...f, [k]: v }));
    // A single line follows the total, as it does on the server when the
    // total is saved (receipts/edit.js). Left behind on screen, it showed a
    // red "≠ total" and held Mark reviewed back over a difference Save was
    // about to put right by itself.
    if (k === 'total') setLines(ls => (ls.length === 1 ? [{ ...ls[0], amount: v }] : ls));
  };
  const setLine = (i, k, v) => { dirty.current = true; setLines(ls => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l))); };
  const editLines = fn => { dirty.current = true; setLines(fn); };

  async function save({ quiet } = {}) {
    setBusy('save');
    try {
      const was = baseline.current.form;
      const body = {};
      for (const [k] of FIELDS) {
        if (String(form[k] ?? '') === String(was[k] ?? '')) continue;
        body[k] = k === 'currency' ? String(form[k] || '').toUpperCase() : form[k];
      }
      // Filing is the owner's; anyone else's save leaves the case alone.
      if (perm.canAct && (form.reportId || '') !== (was.reportId || '')) body.reportId = form.reportId || null;
      if (Object.keys(body).length) await api.patch(`/expenses/${id}`, body);
      // The server has already moved a single line with a new total, so a
      // line that only followed the total needs no second request.
      const was1 = baseline.current.raw;
      const followed = 'total' in body && lines.length === 1 && was1.length === 1 && cents(lines[0].amount) === cents(form.total);
      const compare = followed ? [{ ...lines[0], amount: was1[0].amount }] : lines;
      if (lines.length && sameLines(compare) !== baseline.current.lines) {
        await api.put(`/expenses/${id}/lines`, { lines: lines.map(l => ({ ...l, amount: Number(l.amount), onBehalfOf: String(l.onBehalfOf || '').trim() || null })) });
      }
      dirty.current = false;
      await load();
      loadHistory().catch(() => {});
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
      loadHistory().catch(() => {});
      setMsg(r.ok ? { tone: 'success', text: `Read again (${r.confidence} confidence).` } : { tone: 'warning', text: 'The reader could not make out this receipt. Type the fields by hand.' });
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(''); }
  }
  async function refreshFx() {
    if (!(await save({ quiet: true }))) return;
    setBusy('fx');
    try { const out = await api.post(`/expenses/${id}/fx`, {}); await load(); loadHistory().catch(() => {}); setMsg(out.pending ? { tone: 'warning', text: `No rate found for ${exp.currency} on that date.` } : { tone: 'success', text: 'Rate refreshed.' }); }
    catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(''); }
  }
  async function submitRate(ev) {
    ev.preventDefault();
    if (!(await save({ quiet: true }))) return;
    setBusy('fx');
    try { await api.patch(`/expenses/${id}/fx`, { rate: Number(rateEdit.rate), reason: rateEdit.reason }); setRateEdit(null); await load(); loadHistory().catch(() => {}); setMsg({ tone: 'success', text: 'Rate changed.' }); }
    catch (e) { setMsg({ tone: 'error', text: e.message }); }
    finally { setBusy(''); }
  }
  async function remove() {
    setConfirm(null);
    // Deleted, so nothing typed on it is left to lose: leave without asking.
    try { await api.delete(`/expenses/${id}`); dirty.current = false; navigate('/expenses'); } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  }

  if (!exp) return <div style={{ color: 'var(--text-muted)' }}>{msg?.text || 'Loading…'}</div>;
  const viewOnly = !perm.isOwner;
  // Locked while a save runs too: what was typed during it was overwritten
  // by the reload that followed.
  const detailsLocked = !perm.canEditDetails || exp.status === 'duplicate' || busy === 'save';
  async function openOriginal() {
    if (!exp.receipt) return;
    // Opened inside the click so the browser allows it, then pointed at a
    // freshly signed link: the page's own may be older than its five minutes.
    const w = window.open('', '_blank');
    if (w) w.opener = null;
    try {
      const d = await api.get(`/receipts/${exp.receipt.id}/token`);
      const url = `/api/receipts/${exp.receipt.id}/image?token=${encodeURIComponent(d.token)}`;
      if (w) w.location.href = url; else window.location.href = url;
    } catch (e) { if (w) w.close(); setMsg({ tone: 'error', text: e.message }); }
  }
  const actionsLocked = !perm.canAct;
  const isPdf = exp.receipt?.mime === 'application/pdf';
  // Where a saved field no longer says what the reader read, show what it
  // read, so a figure that drifted from the paper is visible at a glance.
  const aiDiffers = k => {
    const read = exp.aiRead ? exp.aiRead[k] : undefined;
    if (read === undefined || read === null || read === '') return false;
    if (k === 'total' || k === 'tax') return Number(read) !== Number(exp[k]);
    return String(read).trim().toLowerCase() !== String(exp[k] ?? '').trim().toLowerCase();
  };
  const idx = group?.siblings?.findIndex(s => s.id === id) ?? -1;
  const prev = idx > 0 ? group.siblings[idx - 1] : null;
  const next = idx >= 0 && idx < (group?.siblings?.length || 0) - 1 ? group.siblings[idx + 1] : null;
  // The owner's open cases can take it, and the one it is already in is shown
  // whatever its state, so a filed receipt never shows a blank box. This list
  // used to be filtered on statuses that no longer exist, so it was always
  // empty: a filed receipt read "Not filed yet", and picking that — the only
  // choice there was — took it out of its case on Save.
  const caseOptions = cases.filter(r => r.userId === exp.userId && (r.status === 'open' || r.id === exp.reportId));
  const caseKnown = !exp.reportId || caseOptions.some(r => r.id === exp.reportId);

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}><Link to="/expenses" style={{ color: 'inherit' }}>← My receipts</Link></div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{exp.merchant || 'Untitled receipt'} <StatusBadge status={exp.status} /></h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {prev && <button className="btn btn-outline btn-sm" onClick={() => navigate(`/expenses/${prev.id}`)}>← Prev</button>}
          {next && <button className="btn btn-outline btn-sm" onClick={() => navigate(`/expenses/${next.id}`)}>Next →</button>}
          {perm.isOwner && <button className="btn btn-outline btn-sm" disabled={actionsLocked} title={locked ? 'The case it is in has been claimed' : ''} onClick={() => setConfirm('delete')}>Delete</button>}
        </div>
      </div>

      {/* Offered, not enforced: any three-letter code still works, because the
          rate providers cover far more currencies than anyone would list. */}
      <datalist id="currency-options">
        {currencies.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
      </datalist>

      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}
      {perm.posted && <div className="alert alert-info">This receipt is in a case that has been posted to Xero, so nothing on it can change now.</div>}
      {!perm.posted && viewOnly && (
        <div className="alert alert-info">
          You are checking someone else&rsquo;s receipt. You can correct its details; every change is logged below and they can see it. Filing, marking it reviewed and deleting stay theirs.
        </div>
      )}
      {!perm.posted && !viewOnly && locked && (
        <div className="alert alert-info">This receipt is in a claimed case. You can still correct its details, and each change is recorded on the case. Reopen the case to file, re-read or delete it.</div>
      )}
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
              <button className="btn btn-outline btn-sm" disabled={busy === 'reread' || !exp.receipt || actionsLocked} title={viewOnly ? 'Only the claimant can re-read it' : ''} onClick={reread}>{busy === 'reread' ? 'Reading…' : 'Re-read'}</button>
              {imageUrl && <button className="btn btn-outline btn-sm" onClick={openOriginal}>Open original</button>}
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
                  <input id={`f-${k}`} className="form-input" type={type} step={type === 'number' ? '0.01' : undefined} value={form[k] ?? ''} disabled={detailsLocked}
                         list={k === 'currency' ? 'currency-options' : undefined}
                         onChange={e => set(k, k === 'currency' ? e.target.value.toUpperCase().slice(0, 3) : e.target.value)}
                         placeholder={k === 'purpose' ? 'Client site visit, Chakan plant' : k === 'currency' ? 'IDR' : ''} />
                  {aiDiffers(k) && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }} title="What the reader first read off the receipt">
                      AI read: {String(exp.aiRead[k])}
                    </div>
                  )}
                  {k === 'currency' && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {currencies.find(c => c.code === form.currency)?.name || 'Pick one, or type any three-letter code'}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="f-report">Case</label>
              <select id="f-report" className="form-input" value={form.reportId || ''} onChange={e => set('reportId', e.target.value)} disabled={actionsLocked}>
                <option value="">Not in a case</option>
                {!caseKnown && <option value={exp.reportId}>{caseHead && caseHead.id === exp.reportId ? `${caseHead.number} ${caseHead.title || ''}` : 'Its case'}</option>}
                {caseOptions.map(r => <option key={r.id} value={r.id}>{r.number} {r.title || ''}</option>)}
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
                        ? `Entered by ${fx.fxOverrideBy || 'an admin'}${fx.fxOverrideReason ? `: ${fx.fxOverrideReason}` : ''}`
                        : `${fxSourceLong(fx.fxSource)} for ${fx.fxRateDate}${fx.fxFetchedAt ? ` · fetched ${formatDateTime(fx.fxFetchedAt, user?.timezone)}` : ''}`}
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
                      ? `${l0.fxCheck} Until then this receipt has no converted amount.`
                      : `No rate yet for ${exp.currency} on ${exp.receiptDate || 'this date'}. Refresh, or enter one.`}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button className="btn btn-outline btn-sm" disabled={!!busy || detailsLocked} onClick={refreshFx}>{busy === 'fx' ? 'Working…' : 'Refresh rate'}</button>
                  <button className="btn btn-outline btn-sm" disabled={!!busy || detailsLocked} onClick={() => setRateEdit({ rate: fx?.fxRate || '', reason: '' })}>Change rate…</button>
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
            <div className="card-subtitle">One line per category on the claim. They must add up to the total{form.currency ? ` in ${form.currency}` : ''}.</div>
            {lines.map((l, i) => (
              <div key={i} className="expense-line">
                <select className="form-input" value={l.category} disabled={detailsLocked} onChange={e => setLine(i, 'category', e.target.value)} aria-label="Category">
                  <option value="">Category…</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input className="form-input" value={l.description} placeholder="Rooms, 3 nights" disabled={detailsLocked} onChange={e => setLine(i, 'description', e.target.value)} aria-label="Description" />
                <input className="form-input" type="number" step="0.01" value={l.amount} disabled={detailsLocked} onChange={e => setLine(i, 'amount', e.target.value)} style={{ textAlign: 'right' }} aria-label="Amount" />
                <button className="btn btn-ghost btn-sm" disabled={detailsLocked} onClick={() => editLines(ls => ls.filter((_, j) => j !== i))} aria-label="Remove line" title="Remove line">✕</button>
                <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={!!l.onBehalfOf} disabled={detailsLocked} onChange={e => setLine(i, 'onBehalfOf', e.target.checked ? (l.onBehalfOf || ' ') : '')} /> paid on behalf of
                  </label>
                  {/* ' ' marks "ticked, no name yet". The value shown used to be trimmed,
                      which ate each space as it was typed: "Jane Tan" became "JaneTan". */}
                  {!!l.onBehalfOf && <input className="form-input" style={{ padding: '4px 8px', fontSize: 12, maxWidth: 220 }} value={l.onBehalfOf === ' ' ? '' : l.onBehalfOf} disabled={detailsLocked} placeholder="Colleague's name" aria-label="Paid on behalf of" onChange={e => setLine(i, 'onBehalfOf', e.target.value || ' ')} />}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: 12.5 }}>
              <button className="btn btn-outline btn-sm" disabled={detailsLocked} onClick={() => editLines(ls => [...ls, { category: '', description: '', amount: Math.max(0, (totalCents - linesCents) / 100).toFixed(2), onBehalfOf: '' }])}>+ Line</button>
              <span style={{ color: reconciled ? 'var(--success)' : 'var(--danger)', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>
                lines {fmtMoney(linesCents / 100, form.currency)} {reconciled ? '✓' : `≠ total ${fmtMoney(totalCents / 100, form.currency)}`}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button className="btn btn-outline" disabled={!!busy || detailsLocked} onClick={() => save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            {perm.isOwner && (
              <button className="btn btn-primary" disabled={!!busy || !reconciled || actionsLocked || exp.status === 'reviewed'} title={reconciled ? '' : 'The lines must add up to the total first'} onClick={markReviewed}>
                {busy === 'review' ? 'Saving…' : (next ? 'Mark reviewed → next' : 'Mark reviewed')}
              </button>
            )}
          </div>

          <ChangeHistory items={history} all={allHistory} onAll={() => setAllHistory(true)} me={user?.id} tz={user?.timezone} />
        </div>
      </div>

      {leaveDialog}
      {confirm === 'delete' && (
        <ConfirmDialog title="Delete this receipt?" message="The photo or PDF goes with it, unless another receipt still uses the same file." confirmLabel="Delete" danger onConfirm={remove} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}

// Who changed what on this receipt. Changes saved together are shown
// together; the newest five are shown until asked for the rest.
const VIA = { assistant: 'through the assistant', reread: 'by re-reading the receipt' };
function ChangeHistory({ items, all, onAll, me, tz }) {
  if (!items) return null;
  const groups = [];
  for (const c of items) {
    const g = groups[groups.length - 1];
    if (g && g.at === c.at && g.actorId === c.actorId && g.via === c.via) g.rows.push(c);
    else groups.push({ at: c.at, actorId: c.actorId, actorName: c.actorName, actorRole: c.actorRole, via: c.via, rows: [c] });
  }
  const shown = all ? groups : groups.slice(0, 5);
  return (
    <div className="card">
      <div className="card-title">Change history</div>
      <div className="card-subtitle">Every change to this receipt&rsquo;s details after it was read, and who made it.</div>
      {!groups.length && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Nothing has been changed since the receipt was read.</div>}
      {shown.map((g, i) => (
        <div key={i} style={{ padding: '8px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            <strong style={{ color: 'var(--text-primary)' }}>{g.actorId && g.actorId === me ? 'You' : (g.actorName || 'Someone')}</strong>
            {g.actorRole === 'admin' && <span className="badge badge-blue" style={{ marginLeft: 6 }}>admin</span>}
            {VIA[g.via] ? ` ${VIA[g.via]}` : ''} · {formatDateTime(g.at, tz)}
          </div>
          {g.rows.map(c => (
            <div key={c.id} style={{ fontSize: 12.5, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
              <span style={{ fontWeight: 600 }}>{c.label}</span>{': '}
              <span style={{ color: 'var(--text-muted)', textDecoration: c.oldValue ? 'line-through' : 'none' }}>{c.oldValue || 'empty'}</span>
              {' → '}
              <span>{c.newValue || 'empty'}</span>
            </div>
          ))}
        </div>
      ))}
      {!all && groups.length > 5 && <button className="btn btn-ghost btn-sm" onClick={onAll}>Show all {groups.length}</button>}
    </div>
  );
}
