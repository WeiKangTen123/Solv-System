import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useViewMode } from '../context/ViewModeContext';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog from '../components/ConfirmDialog';
import StatusBadge from '../components/StatusBadge';
import { FlagList } from '../components/ui';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { getCompany } from '../utils/useCompany';
import { useLeaveGuard } from '../utils/useLeaveGuard';
import { usePageCrumbs } from '../utils/crumbs';
import {
  ReceiptViewer, ReceiptFields, ExchangeRatePanel, LinesEditor, ChangeHistory, useReceiptForm,
  PAGE_FIELDS, flagsOn, flagsOff, refusedFields,
} from '../components/receipt';

// Image on the left, fields on the right, so a figure is checked against the
// receipt without switching context. Below the fields, the split into report
// lines, which must add up to the total before the expense can be reviewed.
//
// This is a receipt's own page: one outside any case, or one reached by a
// link. A receipt in a case is checked on the case's review page
// (CaseReview.jsx), built from the same pieces (components/receipt), and this
// page offers the way there.
export default function ExpenseReview() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isMobile } = useViewMode();
  const { user } = useAuth();
  const baseCurrency = user?.baseCurrency || 'SGD';
  const [exp, setExp] = useState(null);
  const [locked, setLocked] = useState(false);
  // What the server says this person may do here: correct the details (the
  // owner or an admin, until the case is in Xero) and act on the claim (the
  // owner, while the case is open).
  const [perm, setPerm] = useState({});
  const [history, setHistory] = useState(null);
  const [allHistory, setAllHistory] = useState(false);
  const [cases, setCases] = useState([]);
  // The link to the receipt's file the server handed out with it. The viewer
  // uses it for the first picture only: renewing the picture on every poll
  // reloaded the PDF (losing scroll and zoom) and downloaded the photo again.
  const [imageToken, setImageToken] = useState(null);
  const [categories, setCategories] = useState([]);
  const [currencies, setCurrencies] = useState([]);
  const [group, setGroup] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [confirm, setConfirm] = useState(null);

  // The boxes, what they said when loaded, and whether anything is typed
  // that a poll must not overwrite (components/receipt/useReceiptForm.js).
  const rf = useReceiptForm(PAGE_FIELDS);
  const { loadFrom, isDirty, markClean } = rf;

  // The id this page is showing now. A reply for another one — a poll still in
  // flight when Prev or Next was pressed — is dropped rather than painted over
  // the new receipt, where Save would then have written it.
  const current = useRef(id);
  // Prev, Next, a link, the browser's back button or closing the tab: any of
  // them asks first while something typed has not been saved.
  const leaveDialog = useLeaveGuard(isDirty, 'What you typed on this receipt has not been saved.');
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
    loadFrom(d.expense, { keepEdits: !!preserveEdits, extra: { reportId: d.expense.reportId || '' } });
    setImageToken(d.imageToken || null);
  }, [id, loadFrom]);
  const loadHistory = useCallback(async () => {
    const asked = id;
    const d = await api.get(`/expenses/${asked}/changes`);
    if (current.current === asked) setHistory(d.changes || []);
  }, [id]);

  // A different receipt is a fresh page: nothing from the last one carries over.
  useEffect(() => {
    current.current = id;
    loadFrom(null);
    setExp(null); setGroup(null); setConfirm(null); setMsg(null); setHistory(null); setAllHistory(false); setImageToken(null);
    load().catch(e => setMsg({ tone: 'error', text: e.message }));
    loadHistory().catch(() => setHistory([]));
    api.get(`/expenses/${id}/group`).then(g => { if (current.current === id) setGroup(g); }).catch(() => setGroup(null));
  }, [id, load, loadHistory, loadFrom]);
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
  // A receipt in a case is reached from the case, so the way back is the
  // case: the link over the title and the header's trail both name it. They
  // used to go to My receipts, where the case had to be found again.
  const caseRow = !inCase ? null : (cases.find(r => r.id === inCase) || (caseHead && caseHead.id === inCase ? caseHead : null));
  const caseName = (caseRow && (caseRow.number || caseRow.title)) || 'Case';
  const { pathname } = useLocation();
  usePageCrumbs(pathname, inCase ? [{ label: 'Cases', to: '/reports' }, { label: caseName, to: `/reports/${inCase}` }, { label: 'Check' }] : null);
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

  async function save({ quiet } = {}) {
    setBusy('save');
    try {
      // Filing is the owner's; anyone else's save leaves the case alone.
      await rf.save(id, { withCase: perm.canAct });
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
  async function submitRate({ rate, reason }) {
    if (!(await save({ quiet: true }))) return false;
    setBusy('fx');
    try { await api.patch(`/expenses/${id}/fx`, { rate, reason }); await load(); loadHistory().catch(() => {}); setMsg({ tone: 'success', text: 'Rate changed.' }); return true; }
    catch (e) { setMsg({ tone: 'error', text: e.message }); return false; }
    finally { setBusy(''); }
  }
  async function remove() {
    setConfirm(null);
    // Back to the case it was in; My receipts only for one that was in none.
    const back = exp.reportId ? `/reports/${exp.reportId}` : '/expenses';
    // Deleted, so nothing typed on it is left to lose: leave without asking.
    try { await api.delete(`/expenses/${id}`); markClean(); navigate(back); } catch (e) { setMsg({ tone: 'error', text: e.message }); }
  }

  if (!exp) return <div style={{ color: 'var(--text-muted)' }}>{msg?.text || 'Loading…'}</div>;
  const viewOnly = !perm.isOwner;
  // Locked while a save runs too: what was typed during it was overwritten
  // by the reload that followed.
  const detailsLocked = !perm.canEditDetails || exp.status === 'duplicate' || busy === 'save';
  const actionsLocked = !perm.canAct;
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
  // The boxes a refusal named are marked, so the reason sits where it is fixed.
  const invalid = msg && msg.tone === 'error' ? refusedFields(msg.text) : [];
  const looseFlags = flagsOff(exp.flags, [...PAGE_FIELDS, 'lines']);

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {inCase
              ? <Link to={`/reports/${inCase}`} style={{ color: 'inherit' }}>← {caseName}</Link>
              : <Link to="/expenses" style={{ color: 'inherit' }}>← My receipts</Link>}
          </div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{exp.merchant || 'Untitled receipt'} <StatusBadge status={exp.status} /></h1>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* The case's receipts are checked together, one after another, on
              its review page; this one opens there where it is. */}
          {inCase && <Link className="btn btn-outline btn-sm" to={`/reports/${inCase}/review?receipt=${encodeURIComponent(id)}`}>Review in case</Link>}
          {prev && <button className="btn btn-outline btn-sm" onClick={() => navigate(`/expenses/${prev.id}`)}>← Prev</button>}
          {next && <button className="btn btn-outline btn-sm" onClick={() => navigate(`/expenses/${next.id}`)}>Next →</button>}
          {perm.isOwner && <button className="btn btn-outline btn-sm" disabled={actionsLocked} title={locked ? 'The case it is in has been claimed' : ''} onClick={() => setConfirm('delete')}>Delete</button>}
        </div>
      </div>

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
          <ReceiptViewer key={id} receipt={exp.receipt} page={exp.page} box={exp.box} token={imageToken} height={isMobile ? 520 : 800}
                         caption={exp.aiReadAt ? `read by AI, ${exp.aiConfidence || 'low'} confidence` : ''}
                         tools={(
                           <button className="btn btn-outline btn-sm" disabled={busy === 'reread' || !exp.receipt || actionsLocked} title={viewOnly ? 'Only the claimant can re-read it' : ''} onClick={reread}>
                             {busy === 'reread' ? 'Reading…' : 'Re-read'}
                           </button>
                         )} />
        </div>

        {/* Fields */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-title">Receipt details</div>
            <div className="card-subtitle">Read from the receipt. Check each one, then say what it was for.</div>
            {looseFlags.length > 0 && <div style={{ marginBottom: 14 }}><FlagList flags={looseFlags} /></div>}
            <ReceiptFields fields={PAGE_FIELDS} form={rf.form} onChange={rf.set} expense={exp} disabled={detailsLocked}
                           categories={categories} currencies={currencies} invalid={invalid} idPrefix="f" />
            <div className="form-group">
              <label className="form-label" htmlFor="f-report">Case</label>
              <select id="f-report" className="form-input" value={rf.form.reportId || ''} onChange={e => rf.set('reportId', e.target.value)} disabled={actionsLocked}>
                <option value="">Not in a case</option>
                {!caseKnown && <option value={exp.reportId}>{caseHead && caseHead.id === exp.reportId ? `${caseHead.number} ${caseHead.title || ''}` : 'Its case'}</option>}
                {caseOptions.map(r => <option key={r.id} value={r.id}>{r.number} {r.title || ''}</option>)}
              </select>
            </div>
            {exp.description && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reader's note: {exp.description}</div>}
          </div>

          <ExchangeRatePanel expense={exp} baseCurrency={baseCurrency} tz={user?.timezone} busy={busy} disabled={detailsLocked}
                             onRefresh={refreshFx} onSetRate={submitRate} />

          <LinesEditor lines={rf.lines} currency={rf.form.currency} total={rf.form.total} categories={categories} disabled={detailsLocked}
                       onLine={rf.setLine} onEdit={rf.editLines} flags={flagsOn(exp.flags, 'lines')} invalid={invalid.includes('lines')} />

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button className="btn btn-outline" disabled={!!busy || detailsLocked} onClick={() => save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            {perm.isOwner && (
              <button className="btn btn-primary" disabled={!!busy || !rf.reconciled || actionsLocked || exp.status === 'reviewed'} title={rf.reconciled ? '' : 'The lines must add up to the total first'} onClick={markReviewed}>
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
