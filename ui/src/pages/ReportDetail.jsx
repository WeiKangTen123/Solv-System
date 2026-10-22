import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useViewMode } from '../context/ViewModeContext';
import { PageHeader, Tabs, tabPanelProps, Stepper, KindBadge, Menu, Skeleton, EmptyState } from '../components/ui';
import IntakePanel from '../components/intake/IntakePanel';
import { useCover } from '../components/intake/useCover';
import CaseStatus from '../components/cases/CaseStatus';
import CaseReceipts from '../components/cases/CaseReceipts';
import CaseTotals from '../components/cases/CaseTotals';
import CaseDetails from '../components/cases/CaseDetails';
import CaseActivity from '../components/cases/CaseActivity';
import PostDialog from '../components/cases/PostDialog';
import MergeDialog from '../components/cases/MergeDialog';
import Poll from '../components/cases/Poll';
import { caseFacts, caseSteps, casePrimary } from '../components/cases/case-logic';
import { usePageCrumbs } from '../utils/crumbs';
import { useLeaveGuard } from '../utils/useLeaveGuard';
import { useOnChanged } from '../utils/useOnChanged';
import { fmtDateRange } from '../utils/format';
import { formatDateTime } from '../utils/formatDate';
import { unpricedText } from '../utils/caseTotals';

// One case: where it is on its way (Receipts → Check → Claim → Xero) and the
// one button for its next step, its receipts (with more dropped straight in),
// its details, and what happened to it. Doing anything to it is its owner's;
// an admin sees it to monitor it, can export it, and can correct a receipt's
// details in the review.
//
// A draft is still being put together on the New case page, and goes there.
const TABS = ['receipts', 'details', 'activity'];

export default function ReportDetail() {
  const { id } = useParams();
  // Another case is another page: nothing ticked, typed or uploading on one
  // carries over to the next (a merge lands on the case it went into).
  return <CasePage key={id} id={id} />;
}

function CasePage({ id }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const { isMobile } = useViewMode();
  const confirm = useConfirm();
  const base = user?.baseCurrency || 'SGD';

  const [view, setView] = useState(null);
  const [loadError, setLoadError] = useState(null);   // { status, message } while nothing is shown
  const [msg, setMsg] = useState(null);               // { tone, text }
  const [busy, setBusy] = useState('');
  const [dialog, setDialog] = useState(null);         // 'post' | 'merge'
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [suggestion, setSuggestion] = useState(null);
  const panelRef = useRef(null);

  const canEdit = !!view && view.editable && view.isOwner;
  const cover = useCover(canEdit ? id : null);
  const coverRef = useRef(cover);
  coverRef.current = cover;
  // A case claimed meanwhile (here or in another tab) closes the form, so
  // it does not come back open after a reopen.
  useEffect(() => { if (!canEdit) setEditing(false); }, [canEdit]);

  // Each load is numbered and only a newer one may replace what is shown: a
  // poll sent before a Check could answer after it and put the receipt back.
  const seq = useRef({ asked: 0, shown: 0 });
  const load = useCallback(async () => {
    const n = ++seq.current.asked;
    const at = Date.now();
    const d = await api.get(`/reports/${id}`);
    if (n < seq.current.shown) return;
    seq.current.shown = n;
    // The owner's draft is the New case page's. Someone else's (an admin
    // looking) stays here: the New case page would only send them back.
    if (d.report.status === 'draft' && d.isOwner) { navigate(`/reports/new?draft=${encodeURIComponent(id)}`, { replace: true }); return; }
    setView(d);
    setLoadError(null);
    coverRef.current.fromServer(d.report, d.report.coverAi, at);
  }, [id, navigate]);
  // A poll that fails keeps what is on screen, except a case that is gone.
  const refresh = useCallback(() => load().catch(err => { if (err.status === 404) setLoadError({ status: 404, message: err.message }); }), [load]);
  useEffect(() => { load().catch(err => setLoadError({ status: err.status, message: err.message })); }, [load]);
  // Receipts are read after they land, so the page comes back on its own:
  // every 2.5 s while any is being read, else every 30 s, and never in a tab
  // nobody is looking at.
  const reading = !!view && view.report.expenses.some(e => e.status === 'reading');
  const pollEvery = reading ? 2500 : 30000;
  // A change applied from the assistant shows straight away.
  useOnChanged(refresh);

  const number = view && view.report.number;
  usePageCrumbs(pathname, [{ label: 'Cases', to: '/reports' }, { label: number || 'Case' }]);

  // Files still uploading are lost if the page goes, so leaving asks. The
  // page's own moves (a tab, which is only a change of ?tab=) do not.
  const ownMove = useRef(false);
  const uploadingRef = useRef(0);
  // The question stays open while the person reads it, and the upload may
  // finish meanwhile; it then says so rather than "0 files are uploading".
  const guard = useLeaveGuard(() => !ownMove.current && uploadingRef.current > 0, uploading > 0
    ? `${uploading} file${uploading === 1 ? ' is' : 's are'} still uploading; leaving stops ${uploading === 1 ? 'it' : 'them'}.`
    : 'The uploads have just finished, so nothing is lost by leaving now.');

  // The tab is in the address so a link or a reload opens on it. Replaced,
  // not pushed: Back leaves the case rather than stepping through its tabs.
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'receipts';
  const setTab = useCallback(t => {
    ownMove.current = true;
    try {
      setParams(prev => { const n = new URLSearchParams(prev); if (t === 'receipts') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });
    } finally { ownMove.current = false; }
  }, [setParams]);

  // The intake panel says when the server's side of the files moved: a read
  // landed, a file was stored. The case is loaded again then, rather than
  // waiting for the next poll. Its answer is the same object until something
  // changes, so this is once per change.
  const lastIntake = useRef(null);
  const onIntake = useCallback(({ intake: d, uploading: n }) => {
    uploadingRef.current = n;
    setUploading(n);
    if (!d || d === lastIntake.current) return;
    const first = !lastIntake.current;
    lastIntake.current = d;
    setSuggestion(d.suggestion || null);
    if (!first) refresh();
  }, [refresh]);
  // Files dropped while another tab is open go in all the same (the whole
  // page takes a drop); the Receipts tab comes up so they can be seen going.
  const wasUploading = useRef(0);
  useEffect(() => {
    if (uploading > 0 && !wasUploading.current && tab !== 'receipts') setTab('receipts');
    wasUploading.current = uploading;
  }, [uploading, tab, setTab]);

  // An action's old message goes when the next one starts: an error from a
  // failed attempt used to stay up over the success that followed it.
  async function act(label, fn) {
    if (busy) return;
    setMsg(null); setBusy(label);
    try { await fn(); await load(); }
    catch (err) { setMsg({ tone: 'error', text: err.message }); }
    finally { setBusy(''); }
  }

  async function exportAs(format) {
    // A PDF opens in a tab of its own; a spreadsheet is a download. Opening a
    // tab for those too left an empty one behind every time, because the
    // file downloads rather than shows.
    if (format !== 'pdf') {
      try {
        const d = await api.get(`/reports/${id}/export-url?format=${format}`);
        // A link with `download`, rather than pointing this tab at the file:
        // that would count as leaving the page.
        const a = document.createElement('a');
        a.href = d.url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (e) { setMsg({ tone: 'error', text: e.message }); }
      return;
    }
    // The window has to be opened inside the click, before the await: opened
    // afterwards the user gesture is spent and Safari blocks it outright, with
    // nothing shown to say why. If the browser blocks it anyway, fall back to
    // navigating this tab rather than failing silently.
    // Opened without 'noopener' because with it the browser returns null, so
    // the tab could never be pointed at the file: every export left a blank
    // tab and navigated this one away. The opener is cut by hand instead.
    const w = window.open('', '_blank');
    if (w) w.opener = null;
    try {
      const d = await api.get(`/reports/${id}/export-url?format=${format}`);
      if (w) w.location = d.url; else window.location.assign(d.url);
    } catch (e) {
      if (w) w.close();
      setMsg({ tone: 'error', text: e.message });
    }
  }

  if (!view) {
    if (loadError) {
      return (
        <EmptyState title={loadError.status === 404 ? 'This case is not there' : 'The case could not be loaded'}
                    action={<Link className="btn btn-outline" to="/reports">Back to Cases</Link>}>
          {loadError.status === 404 ? 'It may have been deleted or merged into another case.' : loadError.message}
        </EmptyState>
      );
    }
    return <div className="cs-page"><Skeleton rows={8} height={40} label="Loading the case" /></div>;
  }

  const r = view.report;
  const { isOwner, xero } = view;
  const posted = !!view.posted;
  const xeroConnected = !!(xero && xero.connected);
  const isAdmin = user?.role === 'admin';
  const facts = caseFacts(r);
  const steps = caseSteps(r, { posted, xeroConnected });
  const primary = casePrimary(r, { isOwner, posted, xeroConnected });
  const gone = loadError && loadError.status === 404;

  async function claim() {
    // One click used to mark it claimed, which locks every receipt in it.
    const ok = await confirm({
      title: `Mark ${r.number} claimed?`,
      message: 'Do this once the claim has gone through your company. Its receipts are then locked; you can reopen it until it is posted to Xero.',
      confirmLabel: 'Mark claimed',
    });
    if (ok) await act('claim', () => api.post(`/reports/${id}/claimed`, {}));
  }

  async function remove() {
    const n = r.expenses.length;
    const ok = await confirm({
      title: `Delete ${r.number || 'this case'}?`,
      message: n
        ? `The ${n} receipt${n === 1 ? '' : 's'} in it stay${n === 1 ? 's' : ''} in My receipts, outside any case; only the case goes.`
        : 'It has no receipts in it, so only the case goes.',
      confirmLabel: 'Delete case', danger: true,
    });
    if (!ok) return;
    setMsg(null); setBusy('delete');
    try { await api.delete(`/reports/${id}`); navigate('/reports'); }
    catch (err) { setMsg({ tone: 'error', text: err.message }); setBusy(''); }
  }

  function runPrimary() {
    if (!primary || busy) return;
    if (primary.id === 'add') panelRef.current?.choose();
    else if (primary.id === 'claim') claim();
    else if (primary.id === 'post') setDialog('post');
  }

  // A line beside the button: why there is no button yet, or what the case
  // is waiting on.
  let note = '';
  if (r.status === 'open' && isOwner) {
    if (!facts.count) note = 'Drop the receipts in below, choose them, or send them from your phone. Each one is read for you.';
    else if (facts.toCheck) note = 'Check every receipt, then put the claim through however your company reimburses you and mark it claimed.';
    else if (facts.reading) note = `${facts.reading} receipt${facts.reading === 1 ? ' is' : 's are'} still being read; ${facts.reading === 1 ? 'it' : 'they'} can be checked once read.`;
    else if (!facts.ready) note = `Not ready to claim yet: ${unpricedText(r.totals) || 'something is missing'}.`;
    else note = 'Every receipt is checked. Mark it claimed once the claim has gone through your company.';
  } else if (r.status === 'claimed') {
    note = posted
      ? `In Xero as draft bill ${r.xeroInvoiceId}${xero?.tenantName ? ` (${xero.tenantName})` : ''}. A case in Xero is final.`
      : `Claimed ${formatDateTime(r.claimedAt, user?.timezone)}.${isOwner && !xeroConnected
        ? (isAdmin ? ' Connect Xero in Settings to post cases as bills.' : ' Xero is not connected yet. Ask your admin if this case should go to Xero.')
        : ''}`;
  }

  // Exports are for a case with a number; a draft has none (the server says
  // 409), and only an admin looking at someone's draft ever sees one here.
  const exportItems = r.status === 'draft' ? [] : [
    { label: 'PDF', hint: 'The claim with its receipts', onSelect: () => exportAs('pdf') },
    { label: 'Excel (XLSX)', onSelect: () => exportAs('xlsx') },
    { label: 'CSV', onSelect: () => exportAs('csv') },
  ];
  const moreItems = !isOwner ? [] : [
    ...(canEdit ? [{ label: 'Merge into another case…', hint: 'Move its receipts there and delete this one', onSelect: () => setDialog('merge') }] : []),
    // Undoing a claim made by mistake: possible until the case is in Xero.
    ...(r.status === 'claimed' && !posted ? [{ label: 'Reopen', hint: 'Unlock it to change or add receipts', onSelect: () => act('reopen', () => api.post(`/reports/${id}/reopen`, {})) }] : []),
    ...(canEdit ? [{ label: 'Delete case', danger: true, onSelect: remove }] : []),
  ];

  const primaryButton = primary && (primary.to
    ? <Link className="btn btn-primary" to={primary.to}>{primary.label} <span aria-hidden="true">→</span></Link>
    : (
      <button type="button" className="btn btn-primary" onClick={runPrimary} disabled={!!busy}>
        {busy === 'claim' ? 'Marking…' : primary.label}
      </button>
    ));

  const meta = [
    r.periodFrom || r.periodTo ? fmtDateRange(r.periodFrom, r.periodTo) : null,
    r.kind === 'trip' && r.destination ? r.destination : null,
    r.number,
  ].filter(Boolean);

  const totals = <CaseTotals report={r} facts={facts} base={base} />;
  const tabs = [
    { id: 'receipts', label: 'Receipts', count: r.expenses.length },
    { id: 'details', label: 'Details' },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <div className="cs-page">
      {guard}
      <Poll key={pollEvery} fn={refresh} every={pollEvery} />
      <PageHeader
        title={r.title || 'Untitled case'}
        subtitle={(
          <span className="cs-meta">
            <KindBadge kind={r.kind} />
            {meta.map((m, i) => <span key={i} className={m === r.number ? 'cs-mono cs-meta-num' : undefined}>{m}</span>)}
          </span>
        )}
        actions={<CaseStatus status={r.status} ready={facts.ready} />}
      />

      {gone && <div className="alert alert-error" role="alert">This case is no longer there: it was deleted or merged. <Link to="/reports">Back to Cases</Link></div>}
      {msg && <div className={`alert alert-${msg.tone}`} role={msg.tone === 'error' ? 'alert' : 'status'}>{msg.text}</div>}
      {r.xeroError && (
        <div className="alert alert-warning">
          <span className="alert-icon">!</span>
          <span>{r.xeroError === 'posting' ? 'Being posted to Xero right now.' : `Xero: ${r.xeroError}`}</span>
        </div>
      )}
      {/* The same rule the review page follows: an admin may correct a
          receipt's details, and acting on the claim stays the owner's. */}
      {!isOwner && (
        <div className="alert alert-info cs-banner">
          <span>
            This is {r.ownerName || r.ownerEmail || 'someone else'}&rsquo;s case. You can read and export it
            {view.canEditDetails ? <>, and correct a receipt&rsquo;s details in <Link to={`/reports/${id}/review`}>the review</Link>; every change is logged and they can see it</> : ''}.
            Filing receipts, claiming and posting to Xero stay theirs.
          </span>
        </div>
      )}

      <section className="card cs-flow" aria-label="Where this case is">
        <Stepper steps={steps} label="Where this case is" />
        <div className="cs-flow-row">
          {note && <p className="cs-flow-note">{note}</p>}
          <div className="cs-flow-actions">
            {primaryButton}
            {exportItems.length > 0 && <Menu label="Export" items={exportItems} align="end" />}
            {moreItems.length > 0 && (
              <Menu label={<><span aria-hidden="true">⋯</span><span className="sr-only">More actions</span></>}
                    items={moreItems} align="end" disabled={!!busy} />
            )}
          </div>
        </div>
      </section>

      {isMobile && totals}

      <div className="cs-grid">
        <div className="cs-main">
          <Tabs tabs={tabs} value={tab} onChange={setTab} label="The case" idBase="case" />
          {/* Every panel stays mounted: the receipts panel holds the uploads
              on their way, which a switch of tab must not drop. */}
          <div {...tabPanelProps('case', 'receipts')} hidden={tab !== 'receipts'} className="cs-panel">
            {canEdit && <IntakePanel ref={panelRef} caseId={id} compact onChange={onIntake} />}
            <CaseReceipts report={r} caseId={id} canEdit={canEdit} base={base} isMobile={isMobile} onChanged={refresh} />
          </div>
          <div {...tabPanelProps('case', 'details')} hidden={tab !== 'details'} className="cs-panel">
            <CaseDetails report={r} cover={cover} suggestion={suggestion} canEdit={canEdit} isOwner={isOwner} base={base}
                         editing={editing} onEdit={on => { setEditing(on); if (!on) refresh(); }} />
          </div>
          <div {...tabPanelProps('case', 'activity')} hidden={tab !== 'activity'} className="cs-panel">
            <CaseActivity report={r} base={base} tz={user?.timezone} />
          </div>
        </div>
        {!isMobile && <aside className="cs-side" aria-label="Totals">{totals}</aside>}
      </div>

      {dialog === 'post' && (
        <PostDialog report={r} base={base} tenantName={xero?.tenantName} onPosted={load} onClose={() => setDialog(null)} />
      )}
      {dialog === 'merge' && (
        <MergeDialog report={r} onClose={() => setDialog(null)}
                     onMerged={into => { setDialog(null); navigate(`/reports/${encodeURIComponent(into)}`); }} />
      )}
    </div>
  );
}
