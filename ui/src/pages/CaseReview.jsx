import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useViewMode } from '../context/ViewModeContext';
import { useConfirm } from '../context/ConfirmContext';
import { getCompany } from '../utils/useCompany';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { useOnChanged } from '../utils/useOnChanged';
import { useLeaveGuard } from '../utils/useLeaveGuard';
import { usePageCrumbs } from '../utils/crumbs';
import { fmtMoney, fmtDay } from '../utils/format';
import { unpricedCount, unpricedText } from '../utils/caseTotals';
import StatusBadge from '../components/StatusBadge';
import Modal from '../components/Modal';
import { PageHeader, FlagList, EmptyState, Skeleton, Menu } from '../components/ui';
import {
  ReceiptViewer, AllowanceCard, ReceiptFields, ExchangeRatePanel, LinesEditor, HistoryDisclosure, ReviewQueue,
  arrange, receiptName, readWords, useReceiptForm, REVIEW_FIELDS, flagsOn, flagsOff, hasRed, refusedFields,
} from '../components/receipt';
import { allowanceOf, nameCaseFlags } from '../utils/allowances';

// Checking a case, one receipt at a time, without leaving the page: the
// receipts on the left in the order they need the person, the receipt itself
// in the middle, and what was read off it on the right, to be put right and
// checked. Check moves on to the next one still to check, so a case of thirty
// is thirty presses of Enter once the reader has done well.
//
// It replaces the check table (CaseCheck.jsx), where every receipt was a row of
// small boxes and the picture opened beside whichever row was picked; and it
// is built from the same pieces as the receipt's own page (components/receipt),
// so a receipt is checked by one set of rules on either.
//
// /reports/:id/review?receipt=<expenseId> opens on that receipt; the address
// follows the receipt on screen (replaced, not pushed: Back leaves the page).

// Words for where a receipt stands, said when it comes on screen.
function standing(e) {
  if (e.status === 'reviewed') return 'Checked.';
  if (e.status === 'reading') return 'Still being read.';
  if (e.status === 'duplicate') return 'A duplicate.';
  const red = (e.flags || []).filter(f => f.level === 'red').length;
  const yellow = (e.flags || []).length - red;
  if (!red && !yellow) return 'Nothing flagged.';
  return [red && `${red} to fix`, yellow && `${yellow} to look at`].filter(Boolean).join(', ') + '.';
}
function describe(e, at, of) {
  return `${at} of ${of}: ${receiptName(e)}${e.receiptDate ? `, ${fmtDay(e.receiptDate)}` : ''}${Number(e.total) > 0 ? `, ${fmtMoney(e.total, e.currency)}` : ''}. ${standing(e)}`;
}
// The receipt after `from` in `order` that is still in `left`, going round
// the end; any other one left when none of them is.
function nextAfter(order, from, left) {
  const at = order.indexOf(from);
  for (let k = 1; k <= order.length; k++) {
    const id = order[(at + k) % order.length];
    if (id !== from && left.has(id)) return id;
  }
  return [...left].find(id => id !== from) || null;
}
const sentence = s => String(s || '').trim().replace(/([^.!?])$/, '$1.');

// Inputs where Enter means "this one is right" rather than something of the
// box's own.
const TEXTY = new Set(['text', 'number', 'date', 'search', 'email', 'tel', 'url']);
// Everything this page sends or waits for; the boxes are held still while one runs.
const LOCKING = new Set(['save', 'check', 'bulk', 'reread', 'delete', 'fx', 'claim']);

export default function CaseReview() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const { user } = useAuth();
  const { isMobile } = useViewMode();
  const confirm = useConfirm();
  const base = user?.baseCurrency || 'SGD';

  const [view, setView] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [reads, setReads] = useState(() => new Map());
  const [selId, setSelId] = useState(null);
  const [categories, setCategories] = useState([]);
  const [currencies, setCurrencies] = useState([]);
  const [busy, setBusy] = useState('');
  const [bulk, setBulk] = useState(null);           // { done, of } while Check all runs
  const [readBusy, setReadBusy] = useState(null);   // the receipt whose read is being acted on
  const [msg, setMsg] = useState(null);             // about the case, over the panes
  const [note, setNote] = useState(null);           // about this receipt, beside its buttons
  const [claimError, setClaimError] = useState(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [showKeys, setShowKeys] = useState(false);
  const [said, setSaid] = useState('');

  const rf = useReceiptForm(REVIEW_FIELDS, { oneLineFromTotal: true });
  const { loadFrom, isDirty } = rf;

  // The case as last shown, and the receipt on screen, for the handlers and
  // the poll, which outlive the render they were made in.
  const viewRef = useRef(null);
  const selRef = useRef(null);
  // The case this page is for. A reply for another one — the address changed
  // while it was on its way — is dropped rather than painted over this one.
  const current = useRef(id);
  // Each load is numbered and only a newer one may replace what is shown: a
  // poll sent before a Check could answer after it and put the checked
  // receipt back in To check.
  const seq = useRef({ asked: 0, shown: 0 });

  // A link, the sidebar, Back or closing the tab asks first while something
  // typed has not been saved. Moving between receipts here asks in its own
  // words (okToMove below).
  const leaveDialog = useLeaveGuard(isDirty, 'What you typed on this receipt has not been saved.');

  const number = view?.report?.number;
  usePageCrumbs(pathname, [{ label: 'Cases', to: '/reports' }, { label: number || 'Case', to: `/reports/${id}` }, { label: 'Review' }]);

  // Said to a screen reader, politely. Cleared first, so the same words
  // twice ("Saved.") are said twice.
  const say = useCallback(text => { setSaid(''); window.setTimeout(() => setSaid(text), 60); }, []);

  // Puts a receipt on screen: its fields fresh, the address following it. One
  // that is not in the case (deleted, moved, or a stale link) gives way to the
  // first that needs checking.
  const show = useCallback((want, d) => {
    const data = d || viewRef.current;
    if (!data) return;
    const list = data.report.expenses;
    let e = (want && list.find(x => x.id === want)) || null;
    if (!e) { const a = arrange(list); e = a.check[0] || a.reading[0] || a.done[0] || null; }
    selRef.current = e ? e.id : null;
    setSelId(selRef.current);
    loadFrom(e);
    setNote(null);
    if (e && new URLSearchParams(window.location.search).get('receipt') !== e.id) navigate({ search: `?receipt=${encodeURIComponent(e.id)}` }, { replace: true });
  }, [loadFrom, navigate]);

  const load = useCallback(async () => {
    const asked = id;
    const n = ++seq.current.asked;
    const d = await api.get(`/reports/${asked}`);
    if (current.current !== asked) return null;
    if (n < seq.current.shown) return viewRef.current;
    seq.current.shown = n;
    // A draft is still being put together on the New case page.
    if (d.report.status === 'draft') { navigate(`/reports/new?draft=${encodeURIComponent(asked)}`, { replace: true }); return null; }
    const v = nameCaseFlags(d);
    viewRef.current = v;
    setView(v);
    return v;
  }, [id, navigate]);

  // How far each file's read has got (GET /reports/:id/intake), for the rows
  // in Reading.
  const loadReads = useCallback(async () => {
    const asked = id;
    const i = await api.get(`/reports/${asked}/intake`);
    if (current.current !== asked) return null;
    setReads(new Map((i.files || []).filter(f => f.read).map(f => [f.receiptId, f.read])));
    return i;
  }, [id]);

  // The case again, keeping the receipt on screen (and what is typed on it,
  // unless keepEdits is false), or moving to `select`.
  const reload = useCallback(async ({ keepEdits = true, select } = {}) => {
    const d = await load();
    if (!d) return null;
    const want = select || selRef.current || new URLSearchParams(window.location.search).get('receipt');
    const same = want && want === selRef.current && d.report.expenses.find(e => e.id === want);
    if (same) loadFrom(same, { keepEdits });
    else show(want, d);
    if (d.report.expenses.some(e => e.status === 'reading')) loadReads().catch(() => {});
    return d;
  }, [load, loadFrom, show, loadReads]);

  // Another case is another page: nothing carries over.
  useEffect(() => {
    current.current = id;
    selRef.current = null;
    viewRef.current = null;
    seq.current = { asked: 0, shown: 0 };
    setView(null); setSelId(null); setReads(new Map()); setMsg(null); setNote(null); setClaimError(null); setLoadError(null);
    loadFrom(null);
    reload().catch(e => setLoadError(e.message));
  }, [id, loadFrom, reload]);

  useEffect(() => { getCompany().then(d => { setCategories(d.categories || []); setCurrencies(d.currencies || []); }).catch(() => {}); }, []);

  // While anything is being read, the read states every 2.5s, and the case
  // again when a read lands, so its fields and flags arrive. Otherwise the
  // case every 30s; never in a tab nobody is looking at.
  const anyReading = () => !!viewRef.current?.report?.expenses?.some(e => e.status === 'reading');
  useVisiblePolling(async () => {
    const v = viewRef.current;
    if (!v) return;
    const was = v.report.expenses.filter(e => e.status === 'reading').map(e => e.id);
    if (!was.length) { await reload(); return; }
    const i = await loadReads();
    if (!i) return;
    const still = new Set([...(i.files || []).flatMap(f => f.expenses || []), ...(i.loose || [])].filter(e => e.status === 'reading').map(e => e.id));
    if (was.some(x => !still.has(x)) || (i.counts && i.counts.receipts !== v.report.expenses.length)) await reload();
  }, () => (anyReading() ? 2500 : 30000));
  // A change applied from the assistant shows straight away; what is typed stays.
  useOnChanged(() => reload());

  // The address changed under the page (a link to another receipt of this
  // case): that receipt comes on screen.
  const urlReceipt = params.get('receipt');
  useEffect(() => {
    if (!viewRef.current || !urlReceipt || urlReceipt === selRef.current) return;
    show(urlReceipt);
  }, [urlReceipt, show]);

  // Each receipt's fields start at the top: the last one's scroll position
  // left the merchant of the next out of sight.
  const fieldsBody = useRef(null);
  useEffect(() => { if (fieldsBody.current) fieldsBody.current.scrollTop = 0; }, [selId]);

  // The keyboard. The handler is made once; what it does is read from
  // `keys`, which each render points at that render's actions.
  const keys = useRef(null);
  useEffect(() => {
    function onKey(e) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const k = keys.current;
      if (!k) return;
      // A dialog over the page has the keyboard.
      if (document.querySelector('[aria-modal="true"]')) return;
      const t = e.target instanceof Element ? e.target : null;
      const tag = t ? t.tagName : '';
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!(t && t.isContentEditable);
      if (e.key === 'Escape') { if (inField) { e.preventDefault(); t.blur(); } return; }
      if (e.key === 'Enter') {
        // Not a held key: one press is one receipt.
        if (e.repeat) return;
        if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return;
        if (tag === 'INPUT' && !TEXTY.has(t.type)) return;
        // The rate form takes its own Enter.
        if (t && t.closest('form, [role="menu"], [role="dialog"]')) return;
        e.preventDefault();
        k.primary();
        return;
      }
      if (inField) return;
      if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') { e.preventDefault(); k.move(1); }
      else if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') { e.preventDefault(); k.move(-1); }
      else if (e.key === '?') { e.preventDefault(); k.help(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!view) {
    keys.current = null;
    return loadError
      ? <div className="alert alert-error">{loadError}</div>
      : <div className="rv"><Skeleton rows={8} height={40} label="Loading the case" /></div>;
  }

  const r = view.report;
  const arranged = arrange(r.expenses);
  const n = arranged.all.length;
  const sel = r.expenses.find(e => e.id === selId) || null;
  const pos = sel ? arranged.all.findIndex(e => e.id === sel.id) : -1;
  // Checking, re-reading and deleting are the owner's while the case is open.
  // Correcting details is wider: the owner or an admin, open or claimed,
  // until the case is in Xero (the server's canEditDetails).
  const canAct = !!view.isOwner && !!view.editable;
  const canEditDetails = !!view.canEditDetails;
  // A per diem or mileage is the company's rate times the trip's days or the
  // km driven, worked out by the server; its boxes are shown, not typed in.
  const allowance = sel ? allowanceOf(sel) : null;
  const locked = !canEditDetails || !sel || sel.status === 'duplicate' || sel.status === 'reading' || !!allowance || LOCKING.has(busy);
  const unflagged = arranged.check.filter(e => e.status === 'review-needed' && !hasRed(e));
  const allDone = n > 0 && !arranged.check.length && !arranged.reading.length;
  const read = sel && sel.receiptId ? reads.get(sel.receiptId) : null;
  const linesOff = rf.lines.length > 0 && !rf.reconciled;
  const checkable = !!sel && canAct && !['reviewed', 'reading', 'duplicate'].includes(sel.status);
  const invalid = note && note.tone === 'error' ? refusedFields(note.text) : [];
  // A split has a category per line, so the receipt's own box goes.
  const shown = rf.lines.length > 1 ? REVIEW_FIELDS.filter(k => k !== 'category') : REVIEW_FIELDS;

  // Moving off a receipt with something typed on it asks first.
  const okToMove = async () => !isDirty() || confirm({
    title: 'Move on without saving?',
    message: 'What you typed on this receipt has not been saved. Press Check (or Save) to keep it.',
    confirmLabel: 'Discard and move on', danger: true,
  });
  async function goTo(target) {
    if (!target || target === selRef.current) return;
    if (!(await okToMove())) return;
    show(target);
    const a = arrange(viewRef.current.report.expenses).all;
    const e = a.find(x => x.id === target);
    if (e) say(describe(e, a.indexOf(e) + 1, a.length));
  }
  function move(dir) {
    const a = arranged.all;
    const at = a.findIndex(e => e.id === selRef.current);
    const t = a[at + dir];
    if (t) goTo(t.id);
  }
  // Skip: on to the next one still to check, leaving this one as it was.
  function skip() {
    if (!sel) return;
    const order = arranged.check.map(e => e.id);
    goTo(nextAfter(order, sel.id, new Set(order)) || arranged.all[pos + 1]?.id || null);
  }

  // Check: what is typed is saved, the receipt is marked checked, and the
  // next one still to check comes up. The server says what is missing when
  // it refuses, and that is shown beside the fields.
  async function check() {
    const e = sel;
    if (!checkable || busy) return;
    const order = arranged.check.map(x => x.id);
    setBusy('check'); setNote(null); setMsg(null);
    try {
      try { await rf.save(e.id); }
      catch (err) { setNote({ tone: 'error', text: err.message }); return; }
      try { await api.patch(`/expenses/${e.id}/status`, { status: 'reviewed' }); }
      catch (err) {
        await reload({ keepEdits: false }).catch(() => {});
        setNote({ tone: 'error', text: err.message });
        say(`Not checked: ${err.message}`);
        return;
      }
      setHistoryVersion(v => v + 1);
      const d = await reload({ keepEdits: false });
      if (!d) return;
      const fresh = arrange(d.report.expenses);
      // Named as saved: the merchant may have been typed just now.
      const was = receiptName(fresh.all.find(x => x.id === e.id) || e);
      const target = nextAfter(order, e.id, new Set(fresh.check.map(x => x.id)));
      if (target) {
        show(target, d);
        const t = fresh.all.find(x => x.id === target);
        say(`Checked ${was}. ${describe(t, fresh.all.indexOf(t) + 1, fresh.all.length)}`);
      } else say(`Checked ${was}. Nothing is left to check.`);
    } catch (err) { setMsg({ tone: 'error', text: err.message }); }
    finally { setBusy(''); }
  }

  // Save without checking: an admin correcting someone's receipt, or the
  // owner of a claimed case.
  async function saveOnly() {
    if (!sel || busy || !canEditDetails) return;
    setBusy('save'); setNote(null);
    try {
      await rf.save(sel.id);
      setHistoryVersion(v => v + 1);
      await reload({ keepEdits: false });
      setNote({ tone: 'success', text: 'Saved.' });
      say('Saved.');
    } catch (err) { setNote({ tone: 'error', text: err.message }); }
    finally { setBusy(''); }
  }

  // The rate is worked out from what is saved, so what is typed is saved first.
  async function refreshFx() {
    if (!sel || busy) return;
    const e = sel;
    setBusy('fx'); setNote(null);
    try {
      await rf.save(e.id);
      const out = await api.post(`/expenses/${e.id}/fx`, {});
      setHistoryVersion(v => v + 1);
      await reload({ keepEdits: false });
      setNote(out.pending ? { tone: 'warning', text: `No rate found for ${out.expense?.currency || e.currency} on that date.` } : { tone: 'success', text: 'Rate refreshed.' });
    } catch (err) { setNote({ tone: 'error', text: err.message }); }
    finally { setBusy(''); }
  }
  async function setRate({ rate, reason }) {
    if (!sel || busy) return false;
    const e = sel;
    setBusy('fx'); setNote(null);
    try {
      await rf.save(e.id);
      await api.patch(`/expenses/${e.id}/fx`, { rate, reason });
      setHistoryVersion(v => v + 1);
      await reload({ keepEdits: false });
      setNote({ tone: 'success', text: 'Rate changed.' });
      return true;
    } catch (err) { setNote({ tone: 'error', text: err.message }); return false; }
    finally { setBusy(''); }
  }

  async function reread() {
    if (!sel || !canAct || busy) return;
    const e = sel;
    if (isDirty() && !(await confirm({ title: 'Read it again?', message: 'Reading the receipt again replaces its fields, and what you typed here has not been saved.', confirmLabel: 'Re-read', danger: true }))) return;
    setBusy('reread'); setNote(null);
    try {
      const out = await api.post(`/expenses/${e.id}/reread`, {});
      setHistoryVersion(v => v + 1);
      await reload({ keepEdits: false });
      setNote(out.ok ? { tone: 'success', text: `Read again (${out.confidence} confidence).` } : { tone: 'warning', text: 'The reader could not make out this receipt. Type the fields by hand.' });
    } catch (err) { setNote({ tone: 'error', text: err.message }); }
    finally { setBusy(''); }
  }

  // Deleting stays on this page and moves to the next receipt still to
  // check; the receipt's own page went back to the case.
  async function remove() {
    if (!sel || !canAct || busy) return;
    const e = sel;
    if (!(await confirm({ title: 'Delete this receipt?', message: 'The photo or PDF goes with it, unless another receipt still uses the same file.', confirmLabel: 'Delete', danger: true }))) return;
    const order = arranged.check.map(x => x.id);
    const all = arranged.all.map(x => x.id);
    setBusy('delete'); setNote(null); setMsg(null);
    try {
      await api.delete(`/expenses/${e.id}`);
      // Deleted, so nothing typed on it is left to lose.
      loadFrom(null);
      selRef.current = null;
      const d = await load();
      if (!d) return;
      const fresh = arrange(d.report.expenses);
      show(nextAfter(order, e.id, new Set(fresh.check.map(x => x.id))) || nextAfter(all, e.id, new Set(fresh.all.map(x => x.id))), d);
      setMsg({ tone: 'success', text: `${receiptName(e)} deleted.` });
      say(`${receiptName(e)} deleted.`);
    } catch (err) { setNote({ tone: 'error', text: err.message }); }
    finally { setBusy(''); }
  }

  // A read waiting on the AI: read it now, or stop waiting and type it in.
  async function tryNow(receiptId) {
    setReadBusy(receiptId); setMsg(null);
    try { await api.post(`/receipts/${receiptId}/read/retry`, {}); await loadReads(); }
    catch (err) { setMsg({ tone: 'error', text: err.message }); }
    finally { setReadBusy(null); }
  }
  async function typeIt(receiptId) {
    setReadBusy(receiptId); setMsg(null);
    try { await api.delete(`/receipts/${receiptId}/read`); await reload(); }
    catch (err) { setMsg({ tone: 'error', text: err.message }); }
    finally { setReadBusy(null); }
  }

  // Every receipt still to check with nothing red on it, one at a time, by
  // the same rule as Check. Not POST /reports/:id/review-all, which checks
  // the flagged ones too. The first refusal stops it: what passed stays
  // checked, the one refused comes on screen with why, and the rest wait.
  async function checkUnflagged() {
    if (!canAct || busy) return;
    setMsg(null); setNote(null);
    // What is typed on the receipt on screen goes first: it may be one of
    // them, and the edit may be what clears its flag.
    if (sel && isDirty()) {
      setBusy('save');
      try { await rf.save(sel.id); }
      catch (err) { setBusy(''); setNote({ tone: 'error', text: err.message }); return; }
    }
    setBusy('bulk');
    try {
      const d0 = await load();
      if (!d0) return;
      const list = arrange(d0.report.expenses).check.filter(e => e.status === 'review-needed' && !hasRed(e));
      let passed = 0, stop = null;
      setBulk({ done: 0, of: list.length });
      for (const e of list) {
        try { await api.patch(`/expenses/${e.id}/status`, { status: 'reviewed' }); passed++; setBulk({ done: passed, of: list.length }); }
        catch (err) { stop = { e, why: err.message }; break; }
      }
      const d = await reload(stop ? { select: stop.e.id, keepEdits: false } : { keepEdits: false });
      if (stop) {
        const untried = list.length - passed - 1;
        const text = `${passed} of ${list.length} checked. ${receiptName(stop.e)} did not pass: ${sentence(stop.why)}${untried ? ` The other ${untried} were not tried; put this one right and press Check all again.` : ''}`;
        setMsg({ tone: 'warning', text });
        setNote({ tone: 'error', text: stop.why });
        say(text);
      } else {
        const rest = d ? arrange(d.report.expenses).check : [];
        const left = rest.length;
        // The receipt on screen was probably one of them; the first that
        // still needs the person comes up instead.
        if (left && d && !rest.some(e => e.id === selRef.current)) show(rest[0].id, d);
        const text = `${passed} checked.${left ? ` ${left} still need${left === 1 ? 's' : ''} you: ${left === 1 ? 'it has' : 'each has'} something to fix.` : ''}`;
        setMsg({ tone: 'success', text });
        say(text);
      }
    } catch (err) { setMsg({ tone: 'error', text: err.message }); }
    finally { setBusy(''); setBulk(null); }
  }

  // Claiming, with the words the case page uses. Anything typed and not yet
  // saved is saved first, so the claim is of what is on screen.
  async function claim() {
    if (!view.isOwner || r.status !== 'open' || busy) return;
    if (!(await confirm({ title: `Mark ${r.number} claimed?`, message: 'Do this once the claim has gone through your company. Its receipts are then locked; you can reopen it until it is posted to Xero.', confirmLabel: 'Mark claimed' }))) return;
    setBusy('claim'); setClaimError(null);
    try {
      if (sel && isDirty()) await rf.save(sel.id);
      await api.post(`/reports/${id}/claimed`, {});
      navigate(`/reports/${id}`);
    } catch (err) { setClaimError(err.message); }
    finally { setBusy(''); }
  }

  // Enter is Check for the owner; for anyone who may only correct details,
  // it saves what they typed.
  function primary() {
    if (checkable && !linesOff) check();
    else if (canEditDetails && isDirty()) saveOnly();
  }
  keys.current = { move, primary, help: () => setShowKeys(true) };

  const rereadButton = canAct && sel && sel.receipt && sel.status !== 'reading' && (
    <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={reread} title="Read the receipt again; its fields are replaced">
      {busy === 'reread' ? 'Reading…' : 'Re-read'}
    </button>
  );
  const viewerCaption = sel && sel.aiReadAt ? `read by AI, ${sel.aiConfidence || 'low'} confidence` : '';

  const readPanel = sel && sel.status === 'reading' && (
    <div className="alert alert-info rv-reading">
      <span>{readWords(read)} The fields fill in when the read lands; there is nothing to type until then.</span>
      {canAct && read && read.state === 'queued' && (
        <span className="rv-reading-actions">
          <button type="button" className="btn btn-outline btn-sm" disabled={readBusy === sel.receiptId} onClick={() => tryNow(sel.receiptId)}>Try now</button>
          <button type="button" className="btn btn-outline btn-sm" disabled={readBusy === sel.receiptId} onClick={() => typeIt(sel.receiptId)}>Type it myself</button>
        </span>
      )}
    </div>
  );

  const fieldsPanel = !sel ? (
    <EmptyState compact title="No receipt picked">Pick one from the list.</EmptyState>
  ) : (
    <>
      <div className="rv-fields-body" ref={fieldsBody}>
        <div className="rv-fields-head">
          <h2 className="rv-fields-name">{receiptName(sel)}</h2>
          <StatusBadge status={sel.status} />
          <span style={{ flex: 1 }} />
          <Menu label="More" align="end" items={[
            { label: 'Open on its own page', onSelect: () => navigate(`/expenses/${sel.id}`) },
            ...(canAct ? [{ label: 'Delete this receipt', danger: true, disabled: !!busy, onSelect: remove }] : []),
          ]} />
        </div>
        {readPanel}
        {sel.errorMsg && sel.status !== 'reading' && (
          <div className="alert alert-warning rv-note">
            <span>{sel.errorMsg}{sel.duplicateOf && <> · <Link to={`/expenses/${sel.duplicateOf}`}>see the other one</Link></>}</span>
          </div>
        )}
        {sel.status === 'duplicate' && canAct && <div className="rv-hint">A duplicate cannot be checked. Delete it from More, or ask an admin if it is not a duplicate.</div>}
        {allowance && (
          <div className="rv-hint">
            {allowance === 'per_diem' ? 'A per diem' : 'Mileage'} is worked out from your company&rsquo;s rate and went in already checked, so there is nothing to type here.
            {canAct ? ` To change it, add it again on the case page${allowance === 'per_diem' ? ', which replaces this one' : ' and delete this one from More'}.` : ''}
          </div>
        )}
        <FlagList flags={flagsOff(sel.flags, [...shown, 'lines'])} />
        <ReceiptFields fields={shown} form={rf.form} onChange={rf.set} expense={sel} disabled={locked}
                       categories={categories} currencies={currencies} invalid={invalid} idPrefix="rv"
                       caseDates={{ from: r.periodFrom, to: r.periodTo }} />
        {sel.status !== 'reading' && (
          <>
            <ExchangeRatePanel compact expense={sel} baseCurrency={base} tz={user?.timezone} busy={busy} disabled={locked}
                               onRefresh={refreshFx} onSetRate={setRate} />
            <LinesEditor card={false} collapseSingle lines={rf.lines} currency={rf.form.currency} total={rf.form.total} category={rf.form.category}
                         categories={categories} disabled={locked} onLine={rf.setLine} onEdit={rf.editLines}
                         flags={flagsOn(sel.flags, 'lines')} invalid={invalid.includes('lines')} />
          </>
        )}
        <HistoryDisclosure key={sel.id} expenseId={sel.id} version={historyVersion} me={user?.id} tz={user?.timezone} />
      </div>
      <div className="rv-actions">
        {note && <div className={`alert alert-${note.tone} rv-actions-note`} role={note.tone === 'error' ? 'alert' : 'status'}>{note.text}</div>}
        <div className="rv-actions-row">
          <button type="button" className="btn btn-outline" disabled={LOCKING.has(busy) || n < 2} onClick={skip} title="Next receipt still to check, leaving this one as it is">Skip</button>
          {canEditDetails && (rf.dirty || !canAct) && (
            <button type="button" className="btn btn-outline" disabled={!!busy || locked || !rf.dirty} onClick={saveOnly}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          )}
          {canAct && (
            <button type="button" className="btn btn-primary rv-check" disabled={!!busy || !checkable || linesOff} onClick={check}
                    title={sel.status === 'reviewed' ? 'Already checked' : linesOff ? 'The lines must add up to the total first' : 'Save and mark checked, then the next one'}>
              {busy === 'check' ? 'Checking…' : sel.status === 'reviewed' ? 'Checked ✓' : <>Check {!isMobile && <kbd>Enter</kbd>}</>}
            </button>
          )}
        </div>
      </div>
    </>
  );

  const queueProps = { expenses: r.expenses, selectedId: selId, onSelect: goTo, reads, canAct, onTryNow: tryNow, onTypeIt: typeIt, busyId: readBusy };
  const subtitle = [
    r.title,
    arranged.check.length ? `${arranged.check.length} to check` : null,
    arranged.reading.length ? `${arranged.reading.length} being read` : null,
    `${arranged.done.length} done`,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`rv${isMobile ? ' is-mobile' : ' is-desktop'}`}>
      <PageHeader
        back={{ to: `/reports/${id}`, label: r.number || 'Case' }}
        title="Review"
        subtitle={subtitle}
        actions={n > 0 && (
          <>
            {pos >= 0 && <span className="rv-pos">{pos + 1} of {n}</span>}
            <button type="button" className="btn btn-outline btn-sm" disabled={pos <= 0 || LOCKING.has(busy)} onClick={() => move(-1)} aria-label="Previous receipt" title="Previous (K)">
              ‹{!isMobile && <> <kbd>K</kbd></>}
            </button>
            <button type="button" className="btn btn-outline btn-sm" disabled={pos < 0 || pos >= n - 1 || LOCKING.has(busy)} onClick={() => move(1)} aria-label="Next receipt" title="Next (J)">
              {!isMobile && <><kbd>J</kbd> </>}›
            </button>
            {canAct && (
              <button type="button" className="btn btn-outline btn-sm" disabled={!!busy || !unflagged.length} onClick={checkUnflagged}
                      title="Check every receipt still to check that has nothing red on it">
                {busy === 'bulk' && bulk ? `Checking ${bulk.done} of ${bulk.of}…` : `Check all unflagged (${unflagged.length})`}
              </button>
            )}
            {!isMobile && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowKeys(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button>}
          </>
        )}
      />

      {msg && <div className={`alert alert-${msg.tone}`} role="status">{msg.text}</div>}
      {view.posted && <div className="alert alert-info">This case is in Xero, so nothing in it can change now.</div>}
      {!view.posted && !view.isOwner && (
        <div className="alert alert-info">
          This is {r.ownerName || r.ownerEmail || 'someone else'}&rsquo;s case. You can correct receipt details while you review it. Every change is logged on the receipt, and they can see it. Checking and claiming stay theirs.
        </div>
      )}
      {!view.posted && view.isOwner && !view.editable && (
        <div className="alert alert-info">This case has been claimed. You can still correct a receipt&rsquo;s details, and each change is recorded on the case. Reopen it to check or add receipts.</div>
      )}

      {allDone && (
        <div className="card rv-end">
          <div className="rv-end-text">
            <div className="rv-end-title">All {n} checked</div>
            <div className="rv-end-sub">
              Total {fmtMoney(r.totals.totalBase, base)}
              {Number(r.advances) > 0 ? ` · to be reimbursed ${fmtMoney(r.totals.reimbursement, base)}` : ''}
              {unpricedCount(r.totals) > 0 ? ` · not in the total yet: ${unpricedText(r.totals)}` : ''}
            </div>
            {claimError && <div className="alert alert-error" style={{ margin: '10px 0 0' }}>{claimError}</div>}
          </div>
          {view.isOwner && r.status === 'open' && (
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={claim}>{busy === 'claim' ? 'Marking…' : 'Claim this case →'}</button>
          )}
          {r.status === 'claimed' && <Link className="btn btn-outline" to={`/reports/${id}`}>Back to the case</Link>}
        </div>
      )}

      {n === 0 ? (
        <EmptyState title="Nothing to review yet" action={<Link className="btn btn-primary" to={`/reports/${id}`}>Go to the case</Link>}>
          Receipts added to this case show here to be checked.
        </EmptyState>
      ) : isMobile ? (
        <div className="rv-mobile">
          <ReviewQueue {...queueProps} variant="select" />
          {sel && (
            allowance ? (
              // The card says the date and the amount itself.
              <AllowanceCard compact expense={sel} base={base} caseDates={{ from: r.periodFrom, to: r.periodTo }} />
            ) : (
              <div className="rv-mobile-receipt">
                <ReceiptViewer key={sel.id} variant="thumb" receipt={sel.receipt} page={sel.page} box={sel.box} />
                <div className="rv-mobile-meta">
                  <div>{fmtDay(sel.receiptDate)}{Number(sel.total) > 0 ? ` · ${fmtMoney(sel.total, sel.currency)}` : ''}</div>
                  {viewerCaption && <div className="rv-hint">{viewerCaption}</div>}
                  {rereadButton}
                </div>
              </div>
            )
          )}
          <div className="card rv-pane rv-pane-fields">{fieldsPanel}</div>
        </div>
      ) : (
        <>
          {/* A window too narrow for three panes: the list becomes one box. */}
          <div className="rv-narrow-queue"><ReviewQueue {...queueProps} variant="select" /></div>
          <div className="rv-grid">
            <div className="card rv-pane rv-pane-queue"><ReviewQueue {...queueProps} /></div>
            <div className="card rv-pane rv-pane-viewer">
              {!sel ? <EmptyState compact title="No receipt picked" />
                // No file to load: what it is and how it was worked out instead.
                : allowance ? <AllowanceCard expense={sel} base={base} caseDates={{ from: r.periodFrom, to: r.periodTo }} />
                : <ReceiptViewer key={sel.id} receipt={sel.receipt} page={sel.page} box={sel.box} tools={rereadButton} caption={viewerCaption} />}
            </div>
            <div className="card rv-pane rv-pane-fields">{fieldsPanel}</div>
          </div>
        </>
      )}

      <div className="sr-only" aria-live="polite" aria-atomic="true">{said}</div>
      {showKeys && <ShortcutsDialog onClose={() => setShowKeys(false)} />}
      {leaveDialog}
    </div>
  );
}

function ShortcutsDialog({ onClose }) {
  return (
    <Modal onClose={onClose} label="Keyboard shortcuts" maxWidth={440}>
      <div className="rv-keys-title">Keyboard shortcuts</div>
      <dl className="rv-keys">
        <dt><kbd>J</kbd> or <kbd>↓</kbd></dt><dd>Next receipt</dd>
        <dt><kbd>K</kbd> or <kbd>↑</kbd></dt><dd>Previous receipt</dd>
        <dt><kbd>Enter</kbd></dt><dd>Check this receipt and go on to the next one still to check. Not in a list or a box of several lines.</dd>
        <dt><kbd>Esc</kbd></dt><dd>Leave the box you are typing in, so J and K move again</dd>
        <dt><kbd>?</kbd></dt><dd>This list</dd>
      </dl>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>Done</button>
      </div>
    </Modal>
  );
}
