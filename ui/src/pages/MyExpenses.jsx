import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useViewMode } from '../context/ViewModeContext';
import {
  PageHeader, SearchInput, FilterChips, EmptyState, Skeleton, FlagList, Pagination, Menu, Checkbox, useSelection, useWindowDrop,
} from '../components/ui';
import { ACCEPT_ATTR } from '../components/receipts/receipt-upload';
import { setPendingFiles } from '../components/intake/handoff';
import { fmtMoney, fmtDay, fmtDateRange } from '../utils/format';
import { casePath, readFailed, receiptLabel, receiptName, receiptPath, skippedText } from '../utils/todo';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { useOnChanged } from '../utils/useOnChanged';

// Every receipt the person has, in any case or none: found by what is printed
// on it, narrowed by the chips, and acted on in bulk (a new case from them,
// into another case, deleted).
//
// Receipts are added through the New case page: "+ Add receipts" and a drop
// anywhere here hand the files over (components/intake/handoff.js), and they
// go into a new draft there. This page used to make a "Receipts, <date>" case
// for every batch on its own.
//
// The chip and the search live in the address (?show=failed&q=grab), so Home
// can link straight to "Failed" and Back returns to the same list.
const PAGE = 50;

// One request brings every receipt (the search is the server's), and each
// chip is a question asked of those rows, so every chip can say how many it
// holds.
const SHOWS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'check', label: 'To check', test: e => e.status === 'review-needed' },
  // A duplicate cannot be put in a case, so it is not counted as missing one.
  { id: 'unfiled', label: 'Not in a case', test: e => !e.reportId && e.status !== 'duplicate' },
  { id: 'failed', label: 'Failed', test: readFailed },
  { id: 'duplicates', label: 'Duplicates', test: e => e.status === 'duplicate' },
];
const EMPTY = {
  check: ['Nothing to check', 'Every receipt has been checked, or is still being read.'],
  unfiled: ['Every receipt is in a case', 'Receipts you add go into a case of their own as they arrive.'],
  failed: ['No failed reads', 'Every receipt was read, or is still being read.'],
  duplicates: ['No duplicates', 'A receipt sent twice shows up here, kept out of any claim.'],
};

// A receipt's state in the words the case pages use: "To check", not "Needs
// review". A read that came back with nothing says so: there is nothing on
// it to check, only fields to type in.
const STATUS = {
  reading: ['Reading', 'badge-blue'], 'review-needed': ['To check', 'badge-yellow'], reviewed: ['Checked', 'badge-green'],
  duplicate: ['Duplicate', 'badge-yellow'], rejected: ['Rejected', 'badge-red'],
};
function Status({ e }) {
  const [label, cls] = readFailed(e) ? ['Not read', 'badge-red'] : (STATUS[e.status] || [e.status || '—', 'badge-gray']);
  return <span className={`badge ${cls}`}>{label}</span>;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const lowerFirst = s => String(s || '').replace(/\.$/, '').replace(/^./, c => c.toLowerCase());
// Clicks on a link inside a clickable row stay there: the row would open the
// receipt as well.
const stop = ev => ev.stopPropagation();

export default function MyExpenses() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const base = user?.baseCurrency || 'SGD';
  const { isMobile } = useViewMode();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const show = SHOWS.some(s => s.id === params.get('show')) ? params.get('show') : 'all';
  const q = params.get('q') || '';

  // null while the first answer is on its way.
  const [rows, setRows] = useState(null);
  const [openCases, setOpenCases] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');
  const [offset, setOffset] = useState(0);
  const pickRef = useRef(null);

  // Only the latest request may paint: a slower answer to an older search
  // landing last showed the list for what had been typed before.
  const latest = useRef(0);
  const load = useCallback(() => {
    const asked = ++latest.current;
    return api.get(`/expenses${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      .then(d => { if (asked === latest.current) { setRows(d.expenses || []); setErr(null); } })
      .catch(e => { if (asked === latest.current) setErr(e.message); });
  }, [q]);
  useEffect(() => { load(); }, [load]);
  useVisiblePolling(load, () => ((rows || []).some(e => e.status === 'reading') ? 2500 : 30000));
  useOnChanged(load);
  // The cases receipts can be moved into. Asked once, and again after a move.
  const loadCases = useCallback(() => api.get('/reports?status=open')
    .then(d => setOpenCases(d.reports || [])).catch(() => setOpenCases([])), []);
  useEffect(() => { loadCases(); }, [loadCases]);
  useEffect(() => { setOffset(0); }, [show, q]);

  const start = useCallback(files => { setPendingFiles(files); navigate('/reports/new'); }, [navigate]);
  const drop = useWindowDrop(start, { label: 'Drop to start a new case with them' });

  // Replaced, not pushed: each chip or search is not a step Back should walk.
  function setParam(key, value) {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  }

  const all = rows || [];
  const chosenShow = SHOWS.find(s => s.id === show);
  const shown = all.filter(chosenShow.test);
  const at = shown.length && offset >= shown.length ? Math.floor((shown.length - 1) / PAGE) * PAGE : offset;
  const pageRows = shown.slice(at, at + PAGE);
  const sel = useSelection(pageRows.map(e => e.id));
  const picked = () => all.filter(e => sel.isSelected(e.id));

  // ── Bulk actions ──
  // A new draft with the chosen receipts, moved out of whatever case they
  // were in; the New case page then shows it filling in.
  async function makeCase() {
    const chosen = picked();
    const ids = chosen.map(e => e.id);
    if (!ids.length || busy) return;
    const inCases = chosen.filter(e => e.reportId);
    if (inCases.length && !(await confirm({
      title: `Start a new case with ${plural(ids.length, 'receipt')}?`,
      message: `${inCases.length === ids.length ? (ids.length === 1 ? 'It is' : 'They are all') : `${inCases.length} of them ${inCases.length === 1 ? 'is' : 'are'}`} in a case now, and will move out of it into the new one.`,
      confirmLabel: 'Start a case',
    }))) return;
    setBusy('make'); setMsg(null);
    let made = null;
    try {
      made = (await api.post('/reports', { draft: true })).report;
      const out = await api.post(`/reports/${made.id}/expenses`, { expenseIds: ids, move: true });
      const skipped = out.skipped || [];
      if (skipped.length >= ids.length) {
        // Nothing went in, so there is no case to show; the draft goes again.
        await api.delete(`/reports/${made.id}?ifEmpty=1`).catch(() => {});
        setMsg({ tone: 'warning', text: `No case was started: ${skippedText(skipped, chosen, fmtDay)}.` });
        return;
      }
      navigate(casePath(made.id, 'draft'));
    } catch (e) {
      if (made) api.delete(`/reports/${made.id}?ifEmpty=1`).catch(() => {});
      setMsg({ tone: 'error', text: e.message });
    } finally {
      setBusy('');
    }
  }

  async function moveTo(c) {
    const chosen = picked();
    const ids = chosen.map(e => e.id);
    if (!ids.length || busy) return;
    setBusy('move'); setMsg(null);
    const where = c.number || c.title || 'the case';
    try {
      const out = await api.post(`/reports/${c.id}/expenses`, { expenseIds: ids, move: true });
      const skipped = out.skipped || [];
      const n = ids.length - skipped.length;
      const why = skippedText(skipped, chosen, fmtDay);
      await Promise.all([load(), loadCases()]);
      sel.clear();
      setMsg(!skipped.length ? { tone: 'success', text: `${plural(n, 'receipt')} in ${where} now.` }
        : n ? { tone: 'warning', text: `${n} moved to ${where}. Not moved: ${why}.` }
        : { tone: 'warning', text: `None moved to ${where}: ${why}.` });
    } catch (e) {
      setMsg({ tone: 'error', text: e.message });
    } finally {
      setBusy('');
    }
  }

  // One at a time, so each refusal (a receipt in a claimed case) is named
  // and the rest still go.
  async function remove() {
    const chosen = picked();
    if (!chosen.length || busy) return;
    if (!(await confirm({
      title: `Delete ${plural(chosen.length, 'receipt')}?`,
      message: 'Each one is deleted with its file and taken out of its case. This cannot be undone.',
      confirmLabel: 'Delete', danger: true,
    }))) return;
    setBusy('delete'); setMsg(null);
    const refused = [];
    let done = 0;
    for (const e of chosen) {
      try { await api.delete(`/expenses/${e.id}`); done++; }
      catch (err) {
        // Gone already (deleted in another tab) is what was asked for.
        if (err.status === 404) done++;
        else refused.push({ id: e.id, why: lowerFirst(err.message) });
      }
    }
    await load();
    sel.clear();
    setBusy('');
    setMsg(!refused.length ? { tone: 'success', text: `${plural(done, 'receipt')} deleted.` }
      : { tone: 'warning', text: `${done ? `${done} deleted. ` : ''}Not deleted: ${skippedText(refused, chosen, fmtDay)}.` });
  }

  const amount = e => (Number(e.total) > 0 ? fmtMoney(e.total, e.currency) : '—');
  const inBase = e => (e.baseTotal != null ? fmtMoney(e.baseTotal) : e.fxPending ? 'rate pending' : '—');
  const caseWords = e => [e.reportNumber || (e.reportStatus === 'draft' ? 'Draft' : null), e.reportTitle].filter(Boolean).join(' · ') || 'Its case';
  const addButton = <button type="button" className="btn btn-primary" onClick={() => pickRef.current && pickRef.current.click()}>+ Add receipts</button>;

  let body;
  if (!rows) body = <Skeleton rows={6} height={44} label="Loading your receipts" />;
  else if (!all.length && !q) {
    body = (
      <EmptyState title="No receipts yet" action={addButton}>
        Drop receipts anywhere on this page, or add them, and a new case is started with them.
      </EmptyState>
    );
  } else if (!shown.length) {
    const [title, words] = q
      ? [`Nothing matches “${q}”`, show === 'all' ? 'The search looks at the merchant, the description and the invoice number.' : `Not under ${chosenShow.label}, at least.`]
      : EMPTY[show];
    body = (
      <EmptyState compact title={title}
                  action={q ? <button type="button" className="btn btn-outline btn-sm" onClick={() => setParam('q', '')}>Clear the search</button>
                    : show !== 'all' ? <button type="button" className="btn btn-outline btn-sm" onClick={() => setParam('show', '')}>Show all receipts</button> : null}>
        {words}
      </EmptyState>
    );
  } else if (isMobile) {
    body = (
      <>
        <div className="mr-pickall">
          <Checkbox checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll}>Select all{shown.length > PAGE ? ' on this page' : ''}</Checkbox>
        </div>
        <ul className="mr-list">
          {pageRows.map(e => (
            <li key={e.id} className={`mr-item${sel.isSelected(e.id) ? ' is-picked' : ''}`}>
              <Checkbox checked={sel.isSelected(e.id)} onChange={on => sel.toggle(e.id, on)} label={`Select ${receiptLabel(e, fmtDay)}`} />
              <Link to={receiptPath(e)} className="mr-item-main">
                <span className="mr-item-top">
                  <span className="mr-name">{receiptName(e)}</span>
                  <span className="mr-num">{amount(e)}</span>
                </span>
                <span className="mr-item-sub">{fmtDay(e.receiptDate)} · {e.reportId ? caseWords(e) : 'Not in a case'}</span>
                <span className="mr-item-tags"><Status e={e} /><FlagList flags={e.flags} compact /></span>
              </Link>
            </li>
          ))}
        </ul>
      </>
    );
  } else {
    body = (
      <div className="mr-table-wrap">
        <table className="data-table mr-table">
          <thead>
            <tr>
              <th className="mr-pick"><Checkbox checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label={shown.length > PAGE ? 'Select all on this page' : 'Select all'} /></th>
              <th>Date</th><th>Merchant</th>
              <th className="mr-right">Amount</th><th className="mr-right">{base}</th>
              <th>Case</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map(e => (
              // The merchant is the row's link, for the keyboard and a screen
              // reader; the rest of the row is a bigger target for the mouse.
              <tr key={e.id} className={`mr-row${sel.isSelected(e.id) ? ' is-picked' : ''}`} onClick={() => navigate(receiptPath(e))}>
                <td className="mr-pick"><Checkbox checked={sel.isSelected(e.id)} onChange={on => sel.toggle(e.id, on)} label={`Select ${receiptLabel(e, fmtDay)}`} /></td>
                <td className="mr-day">{fmtDay(e.receiptDate)}</td>
                <td className="mr-merchant">
                  <Link to={receiptPath(e)} onClick={stop} className="mr-name">{receiptName(e)}</Link>
                  {readFailed(e) && e.errorMsg && <div className="mr-note">{e.errorMsg}</div>}
                </td>
                <td className="mr-right mr-num">{amount(e)}</td>
                <td className={`mr-right mr-num${e.fxPending && e.baseTotal == null ? ' is-wait' : ''}`}>{inBase(e)}</td>
                <td className="mr-case">
                  {e.reportId
                    ? <Link to={casePath(e.reportId, e.reportStatus)} onClick={stop}>{caseWords(e)}</Link>
                    : <span className="mr-quiet">Not in a case</span>}
                </td>
                <td className="mr-status"><Status e={e} /><FlagList flags={e.flags} compact /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="mr-page">
      {drop.overlay}
      <PageHeader title="My receipts" subtitle="Every receipt you have added, in a case or not, newest first." actions={addButton} />
      {/* Hidden, and emptied after each pick so the same file can be chosen again. */}
      <input ref={pickRef} type="file" hidden tabIndex={-1} accept={ACCEPT_ATTR} multiple
             onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; if (files.length) start(files); }} />

      {err && <div className="alert alert-error" role="alert">Could not load your receipts: {err}</div>}
      {msg && <div className={`alert alert-${msg.tone}`} role={msg.tone === 'error' ? 'alert' : 'status'}>{msg.text}</div>}

      <div className="mr-tools">
        <div className="mr-search">
          <SearchInput value={q} onChange={v => setParam('q', v)} placeholder="Search merchant, description, invoice no." label="Search your receipts" />
        </div>
        <FilterChips label="Show receipts" value={show} onChange={id => setParam('show', id === 'all' ? '' : id)}
                     options={SHOWS.map(s => ({ id: s.id, label: s.label, count: rows ? all.filter(s.test).length : undefined }))} />
      </div>

      <div className="card mr-card">
        {body}
        {rows && shown.length > 0 && <Pagination total={shown.length} limit={PAGE} offset={at} onChange={setOffset} label="Receipt pages" />}
      </div>

      {sel.count > 0 && (
        <div className="mr-bulk" role="region" aria-label="Selected receipts">
          <div className="mr-bulk-head">
            <span className="mr-bulk-count" aria-live="polite">{sel.count} selected</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={sel.clear} disabled={!!busy}>Clear</button>
          </div>
          <div className="mr-bulk-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={makeCase} disabled={!!busy}>{busy === 'make' ? 'Starting…' : 'Make a case'}</button>
            <Menu label={busy === 'move' ? 'Moving…' : 'Move to case'} disabled={!!busy} empty={openCases ? 'No open cases' : 'Loading the cases…'}
                  items={(openCases || []).map(c => ({
                    label: [c.number, c.title || 'Untitled case'].filter(Boolean).join(' · '),
                    hint: c.periodFrom || c.periodTo ? fmtDateRange(c.periodFrom, c.periodTo) : undefined,
                    onSelect: () => moveTo(c),
                  }))} />
            <button type="button" className="btn btn-danger btn-sm" onClick={remove} disabled={!!busy}>{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
