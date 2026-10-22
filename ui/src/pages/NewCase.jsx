import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useViewMode } from '../context/ViewModeContext';
import { PageHeader, Skeleton } from '../components/ui';
import IntakePanel from '../components/intake/IntakePanel';
import CoverForm from '../components/intake/CoverForm';
import CaseSummary from '../components/intake/CaseSummary';
import { useCover } from '../components/intake/useCover';
import { takePendingFiles } from '../components/intake/handoff';
import { usePageCrumbs } from '../utils/crumbs';
import { useLeaveGuard } from '../utils/useLeaveGuard';
import { fmtDateRange } from '../utils/format';

// New case: receipts first. The person drops the receipts and the case's
// details fill in beside them as the AI reads them; anything they type is
// theirs. Nothing exists on the server until the first file is dropped (or
// Save draft is pressed with something typed): then a draft is made and the
// address becomes ?draft=<id>, so a reload, or coming back later, carries on
// with it. "Create case" gives the draft its number and opens the check.
//
// A draft whose receipts all fall inside an open case's dates is offered
// that case instead ("Move them there").
const CRUMBS = [{ label: 'Cases', to: '/reports' }, { label: 'New case' }];
const keptKey = id => `solv:keep-new-case:${id}`;

// The address can change under the page: ?draft=<id> that this page wrote
// for its own draft is the same case, while going to /reports/new (the nav's
// New case) or to another draft is a fresh page, so the form below is
// started again rather than carrying one case's files into the next.
export default function NewCase() {
  const [params] = useSearchParams();
  const draft = params.get('draft') || '';
  const made = useRef(new Set());
  const [session, setSession] = useState({ n: 0, draft });
  if (draft !== session.draft) setSession(made.current.has(draft) ? { ...session, draft } : { n: session.n + 1, draft });
  return <NewCaseForm key={session.n} draftId={session.draft} onMade={id => made.current.add(id)} />;
}

function NewCaseForm({ draftId, onMade }) {
  const { pathname } = useLocation();
  usePageCrumbs(pathname, CRUMBS);
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const { user } = useAuth();
  const base = (user && user.baseCurrency) || 'SGD';
  const { isMobile } = useViewMode();
  const confirm = useConfirm();
  const panelRef = useRef(null);

  const [caseId, setCaseId] = useState(null);
  const caseRef = useRef(null);
  const [loading, setLoading] = useState(!!draftId);
  const [msg, setMsg] = useState('');
  const [intake, setIntake] = useState(null);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState('');          // 'create' | 'save' | 'discard' | 'merge'
  const [kept, setKept] = useState(false);
  const cover = useCover(caseId);
  const coverRef = useRef(cover);
  coverRef.current = cover;
  const madeRef = useRef(onMade);
  madeRef.current = onMade;

  // This page's own moves (its draft's address, Create, Discard) pass the
  // leave guard; the router asks it at the moment of navigating.
  const ownMove = useRef(false);
  const go = useCallback((to, opts) => {
    ownMove.current = true;
    try { navigate(to, opts); } finally { ownMove.current = false; }
  }, [navigate]);

  const guard = useLeaveGuard(() => {
    if (ownMove.current) return false;
    const n = panelRef.current ? panelRef.current.uploading() : 0;
    return n > 0 || (!caseRef.current && coverRef.current.anyTyped());
  }, uploading > 0
    ? `${uploading} file${uploading === 1 ? ' is' : 's are'} still uploading; leaving stops ${uploading === 1 ? 'it' : 'them'}.`
    : 'What you typed has not been saved. Save draft keeps it.');

  // ?draft=<id>: carry on with that draft. One that has been created since
  // is its case page's now.
  useEffect(() => {
    // The page's own draft, whose id it has just put in the address, is
    // already here.
    if (!draftId || draftId === caseRef.current) return undefined;
    let alive = true;
    api.get(`/reports/${draftId}`)
      .then(d => {
        if (!alive) return;
        const r = d.report;
        if (r.status !== 'draft' || !d.isOwner) { go(`/reports/${r.id}`, { replace: true }); return; }
        caseRef.current = r.id;
        madeRef.current(r.id);
        setCaseId(r.id);
        coverRef.current.fromServer(r, r.coverAi);
        setLoading(false);
      })
      .catch(err => {
        if (!alive) return;
        setLoading(false);
        setMsg(err.status === 404 ? 'That draft is no longer there: it was created, merged or discarded. Anything dropped here now starts a new one.' : err.message);
      });
    return () => { alive = false; };
  }, [draftId, go]);

  // The draft is made when something first needs a case: the first file, the
  // phone's code, or Save draft with something typed. It is made with what
  // the person typed and nothing else, so the AI is left the rest (the kind
  // included, unless they chose one). Two files dropped at once wait on the
  // same request.
  const creating = useRef(null);
  const ensureCase = useCallback(() => {
    if (caseRef.current) return Promise.resolve(caseRef.current);
    if (!creating.current) {
      const p = (async () => {
        const sent = coverRef.current.typed();
        const d = await api.post('/reports', { draft: true, ...sent });
        const id = d.report.id;
        caseRef.current = id;
        madeRef.current(id);
        setCaseId(id);
        coverRef.current.adopt(id, sent, d.report);
        // Replaced, not pushed: Back leaves the page rather than stepping
        // through its own address change.
        ownMove.current = true;
        try { setParams(prev => { const n = new URLSearchParams(prev); n.set('draft', id); return n; }, { replace: true }); }
        finally { ownMove.current = false; }
        return id;
      })();
      creating.current = p;
      p.catch(() => {}).finally(() => { if (creating.current === p) creating.current = null; });
    }
    return creating.current;
  }, [setParams]);

  // Files handed over by Home or My receipts (components/intake/handoff.js),
  // once the panel is on screen. Taken once: a remount takes nothing again.
  const took = useRef(false);
  useEffect(() => {
    if (loading || took.current) return;
    took.current = true;
    const files = takePendingFiles();
    if (files.length && panelRef.current) panelRef.current.add(files);
    // ?phone=1 is Home's "Use my phone": the code opens at once, on the draft
    // its photos will land in. Read here, once, like the handed-over files.
    if (new URLSearchParams(window.location.search).get('phone') === '1' && panelRef.current) panelRef.current.phone();
  }, [loading]);

  const onIntake = useCallback(({ intake: d, at, uploading: n }) => {
    setUploading(n);
    if (!d) return;
    setIntake(d);
    coverRef.current.fromServer(d.cover, d.coverAi, at);
  }, []);

  useEffect(() => {
    if (!caseId) return;
    try { setKept(sessionStorage.getItem(keptKey(caseId)) === '1'); } catch { /* storage refused: the banner just shows again */ }
  }, [caseId]);
  function keepNew() {
    setKept(true);
    try { sessionStorage.setItem(keptKey(caseId), '1'); } catch { /* as above */ }
  }

  async function create() {
    if (busy) return;
    setBusy('create'); setMsg('');
    try {
      if (caseRef.current) {
        const id = caseRef.current;
        // What is still unsaved goes with the call that creates the case.
        try { await api.post(`/reports/${id}/open`, cover.unsaved()); }
        catch (err) { if (err.status !== 409) throw err; /* created already, by a second click or another tab */ }
        cover.cancel();
        go(`/reports/${id}/review`);
      } else {
        const d = await api.post('/reports', cover.typed());
        cover.cancel();
        go(`/reports/${d.report.id}`);
      }
    } catch (err) { setMsg(err.message); setBusy(''); }
  }

  async function saveDraft() {
    if (busy) return;
    setBusy('save'); setMsg('');
    try {
      if (!caseRef.current) await ensureCase();
      await cover.flush();
      // Not the page's own move: files still uploading are asked about.
      navigate('/reports');
    } catch (err) { setMsg(`The draft could not be saved: ${err.message}`); }
    finally { setBusy(''); }
  }

  async function discard() {
    if (busy) return;
    if (!caseRef.current) { cover.cancel(); go('/reports'); return; }
    const n = (intake && intake.counts && intake.counts.receipts) || 0;
    const ok = await confirm({
      title: n ? `Discard this draft and its ${n} receipt${n === 1 ? '' : 's'}?` : 'Discard this draft?',
      message: 'The draft and every file in it are deleted. This cannot be undone.',
      confirmLabel: 'Discard', danger: true,
    });
    if (!ok) return;
    setBusy('discard'); setMsg('');
    if (panelRef.current) panelRef.current.stop();
    cover.cancel();
    try { await api.delete(`/reports/${caseRef.current}?withReceipts=1`); go('/reports'); }
    catch (err) {
      if (err.status === 404) { go('/reports'); return; }
      setMsg(err.message); setBusy('');
    }
  }

  async function merge() {
    const m = intake && intake.match;
    if (!m || busy) return;
    setBusy('merge'); setMsg('');
    try {
      cover.cancel();
      await api.post(`/reports/${caseRef.current}/merge`, { into: m.id });
      go(`/reports/${m.id}`);
    } catch (err) { setMsg(err.message); setBusy(''); }
  }

  const match = intake && intake.match;
  const counts = (intake && intake.counts) || {};
  const pending = (counts.queued || 0) + (counts.reading || 0);
  const titled = !!cover.values.title.trim();
  const canCreate = !busy && !uploading && (caseId || titled);
  const hint = uploading ? `Waiting for ${uploading} upload${uploading === 1 ? '' : 's'} to finish.`
    : !caseId && !titled ? 'Drop the receipts, or give the case a title.'
    : pending ? 'Reading carries on after the case is created.' : '';
  const form = <CoverForm cover={cover} suggestion={intake && intake.suggestion} base={base} disabled={busy === 'create' || busy === 'discard'} />;

  return (
    <div className="nc-page">
      {guard}
      <PageHeader
        title={<>New case {caseId && <span className="badge badge-gray">Draft</span>}</>}
        subtitle="Drop the receipts first. The AI reads them and fills in the details; anything you type is yours."
        actions={(
          <>
            <button type="button" className="btn btn-ghost" onClick={discard} disabled={!!busy || loading}>Discard</button>
            <button type="button" className="btn btn-outline" onClick={saveDraft} disabled={!!busy || loading || (!caseId && !cover.anyTyped())}>
              {busy === 'save' ? 'Saving…' : 'Save draft'}
            </button>
          </>
        )}
      />
      {msg && <div className="alert alert-error" role="alert"><span className="alert-icon">✕</span>{msg}</div>}

      {loading ? <Skeleton rows={6} height={44} label="Loading the draft" /> : (
        <>
          {match && !kept && (
            <div className="nc-match" role="status">
              <div className="nc-match-text">
                These receipts fit <strong>{[match.number, match.title].filter(Boolean).join(' · ')}</strong>
                {(match.periodFrom || match.periodTo) && <> ({fmtDateRange(match.periodFrom, match.periodTo)})</>}.
              </div>
              <div className="nc-match-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={merge} disabled={!!busy || uploading > 0}
                        title={uploading ? 'Wait for the uploads to finish' : undefined}>
                  {busy === 'merge' ? 'Moving…' : 'Move them there'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={keepNew}>Keep a new case</button>
              </div>
            </div>
          )}

          <div className="nc-grid">
            <div className="nc-main">
              <IntakePanel ref={panelRef} caseId={caseId} ensureCase={ensureCase} onChange={onIntake} />
            </div>
            <aside className="nc-side" aria-label="Case details">
              {isMobile
                ? <details className="card nc-fold"><summary>Details (filled by AI)</summary>{form}</details>
                : <div className="card nc-cover">{form}</div>}
              <CaseSummary intake={intake} base={base} />
            </aside>
          </div>

          <div className="nc-foot">
            {hint && <span className="nc-foot-hint">{hint}</span>}
            <button type="button" className="btn btn-primary btn-lg" onClick={create} disabled={!canCreate}>
              {busy === 'create' ? 'Creating…' : caseId ? 'Create case and check receipts →' : 'Create case →'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
