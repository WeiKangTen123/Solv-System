import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import { useConfirm } from '../../context/ConfirmContext';
import { Checkbox, EmptyState, FlagList, Menu, useSelection } from '../ui';
import { fmtDateRange, fmtDay, fmtMoney } from '../../utils/format';
import { onBehalfNames, receiptState, summarise } from './case-logic';
import { ALLOWANCE_LABEL, allowanceOf, allowanceWords } from '../../utils/allowances';
import { rateText, taxSummary } from '../../utils/printed';

// The receipts of a case, one row each: its date, merchant, amount (with the
// tax it prints under it, by name and rate, for a receipt kept as printed),
// what it comes to in the company's currency, and whether it has been
// checked. A row
// opens the receipt in the review page. The owner of a case still taking
// receipts can tick rows and check them, move them to another case, or take
// them out of this one; nobody else gets the boxes.
//
// Props:
//   report     the case (GET /reports/:id), its expenses carrying `flags`.
//   caseId     its id.
//   canEdit    the owner, and the case is a draft or open.
//   base       the company's currency.
//   isMobile   rows become a list a thumb can use.
//   onChanged  async fn(): the page loads the case again.
// A per diem or mileage has no file to be named by: it is called what it is,
// and its description says how it was worked out.
const nameOf = e => ALLOWANCE_LABEL[allowanceOf(e)] || e.merchant || (e.receipt && e.receipt.originalName) || 'Untitled';
const subOf = e => (allowanceOf(e) ? allowanceWords(e) || 'No receipt' : e.status === 'reading' ? 'Being read…' : summarise(e.lines));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A refusal's reason, as a clause after a name: the server says sentences.
const clause = s => String(s || '').trim().replace(/\.$/, '').replace(/^./, c => c.toLowerCase());
// At most a few named; a list of thirty reasons is not read.
function listed(items) {
  const shown = items.slice(0, 3).map(x => `${x.name}: ${clause(x.why)}`);
  return items.length > 3 ? [...shown, `and ${items.length - 3} more`] : shown;
}

export default function CaseReceipts({ report, caseId, canEdit, base, isMobile, onChanged }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const list = report.expenses || [];
  const sel = useSelection(canEdit ? list.map(e => e.id) : []);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(null);   // { done, of } while Check runs
  const [msg, setMsg] = useState(null);             // { tone, text, items? }
  const [targets, setTargets] = useState(null);     // the owner's other cases still taking receipts
  const reviewHref = e => `/reports/${encodeURIComponent(caseId)}/review?receipt=${encodeURIComponent(e.id)}`;

  // Where ticked receipts can go, asked for once something is ticked: the
  // owner's other drafts and open cases (a claimed one takes nothing).
  const loadTargets = useCallback(() => api.get('/reports?status=open,draft')
    .then(d => setTargets((d.reports || []).filter(c => c.id !== caseId)))
    .catch(() => setTargets([])), [caseId]);
  useEffect(() => { if (canEdit && sel.count > 0 && !targets) loadTargets(); }, [canEdit, sel.count, targets, loadTargets]);

  const picked = () => list.filter(e => sel.isSelected(e.id));

  // Each ticked receipt that is read and waiting is checked by the same rule
  // as the review page's Check, one at a time, and every refusal is said with
  // its reason. Unlike the review page's "Check all unflagged" it does not
  // stop at the first: these are the ones the person picked. The refused stay
  // ticked, so what is left to look at is still in hand.
  async function checkPicked() {
    if (busy) return;
    const rows = picked();
    const todo = rows.filter(e => receiptState(e) === 'check');
    const already = rows.filter(e => receiptState(e) === 'checked').length;
    const reading = rows.filter(e => receiptState(e) === 'reading').length;
    const dupes = rows.filter(e => receiptState(e) === 'duplicate').length;
    setBusy('check'); setMsg(null);
    let ok = 0;
    const refused = [];
    try {
      setProgress({ done: 0, of: todo.length });
      for (const e of todo) {
        try { await api.patch(`/expenses/${e.id}/status`, { status: 'reviewed' }); ok++; }
        catch (err) { refused.push({ id: e.id, name: nameOf(e), why: err.message }); }
        setProgress({ done: ok + refused.length, of: todo.length });
      }
      await onChanged();
      sel.clear();
      refused.forEach(x => sel.toggle(x.id, true));
      const left = [
        already ? `${already} already checked` : '',
        reading ? `${reading} still being read` : '',
        dupes ? `${plural(dupes, 'duplicate')}, which cannot be checked` : '',
      ].filter(Boolean);
      setMsg({
        tone: refused.length ? 'warning' : 'success',
        text: `${plural(ok, 'receipt')} checked.${left.length ? ` Left as they were: ${left.join(', ')}.` : ''}${refused.length ? ` ${refused.length} could not be:` : ''}`,
        items: refused.length ? listed(refused) : null,
      });
    } catch (err) { setMsg({ tone: 'error', text: err.message }); }
    finally { setBusy(''); setProgress(null); }
  }

  // Into another of the owner's cases, out of this one. What the server
  // would not move comes back in `skipped`, each with why.
  async function moveTo(target) {
    if (busy) return;
    const rows = picked();
    if (!rows.length) return;
    const where = target.number || (target.title ? `the draft “${target.title}”` : 'the draft');
    setBusy('move'); setMsg(null);
    try {
      const d = await api.post(`/reports/${target.id}/expenses`, { expenseIds: rows.map(e => e.id), move: true });
      const skipped = (d.skipped || []).map(s => ({ name: nameOf(rows.find(e => e.id === s.id) || {}), why: s.why }));
      const moved = rows.length - skipped.length;
      await onChanged();
      sel.clear();
      setTargets(null);
      setMsg({
        tone: skipped.length ? 'warning' : 'success',
        text: `${plural(moved, 'receipt')} moved to ${where}.${skipped.length ? ` ${skipped.length} not moved:` : ''}`,
        items: skipped.length ? listed(skipped) : null,
      });
    } catch (err) { setMsg({ tone: 'error', text: err.message }); }
    finally { setBusy(''); }
  }

  // Out of the case, into My receipts with no case: nothing is deleted.
  async function removePicked() {
    if (busy) return;
    const rows = picked();
    if (!rows.length) return;
    const ok = await confirm({
      title: `Take ${plural(rows.length, 'receipt')} out of this case?`,
      message: `${rows.length === 1 ? 'It stays' : 'They stay'} in My receipts, outside any case. Nothing is deleted.`,
      confirmLabel: 'Remove from case', danger: true,
    });
    if (!ok) return;
    setBusy('remove'); setMsg(null);
    let out = 0;
    const refused = [];
    try {
      for (const e of rows) {
        try { await api.delete(`/reports/${caseId}/expenses/${e.id}`); out++; }
        catch (err) {
          // Already out (another tab took it) is what was wanted.
          if (err.status === 404) out++;
          else refused.push({ name: nameOf(e), why: err.message });
        }
      }
      await onChanged();
      sel.clear();
      setMsg({
        tone: refused.length ? 'warning' : 'success',
        text: `${plural(out, 'receipt')} taken out of this case.${refused.length ? ` ${refused.length} could not be:` : ''}`,
        items: refused.length ? listed(refused) : null,
      });
    } catch (err) { setMsg({ tone: 'error', text: err.message }); }
    finally { setBusy(''); }
  }

  const behalf = onBehalfNames(list);
  const moveItems = (targets || []).map(c => ({
    label: `${c.number || 'Draft'} · ${c.title || 'Untitled draft'}`,
    hint: c.periodFrom || c.periodTo ? fmtDateRange(c.periodFrom, c.periodTo) : undefined,
    onSelect: () => moveTo(c),
  }));

  return (
    <section className="card cs-receipts" aria-label="Receipts in this case">
      {msg && (
        <div className={`alert alert-${msg.tone} cs-msg`} role={msg.tone === 'error' ? 'alert' : 'status'}>
          <div>
            {msg.text}
            {msg.items && <ul className="cs-msg-list">{msg.items.map((t, i) => <li key={i}>{t}</li>)}</ul>}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMsg(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {!list.length ? (
        <EmptyState compact title="No receipts yet">
          {canEdit ? 'Drop them above, choose files, or send them from your phone. Each one is read for you.' : 'Nothing is filed in this case.'}
        </EmptyState>
      ) : isMobile ? (
        <ul className="cs-rlist">
          {list.map(e => (
            <li key={e.id} className={`cs-ritem${sel.isSelected(e.id) ? ' is-picked' : ''}`} onClick={() => navigate(reviewHref(e))}>
              {canEdit && <Checkbox checked={sel.isSelected(e.id)} onChange={on => sel.toggle(e.id, on)} label={`Select ${nameOf(e)}`} />}
              <div className="cs-ritem-main">
                <Link to={reviewHref(e)} className="cs-rname" onClick={ev => ev.stopPropagation()}>{nameOf(e)}</Link>
                <div className="cs-sub">{fmtDay(e.receiptDate)}{Number(e.total) > 0 ? ` · ${fmtMoney(e.total, e.currency)}` : ''}</div>
                <TaxLine e={e} />
                {allowanceOf(e) && <div className="cs-sub al-row-words">{subOf(e)}</div>}
              </div>
              <div className="cs-ritem-side">
                <Base e={e} />
                <CheckCell e={e} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="cs-table-wrap">
          <table className="data-table cs-rtable">
            <thead>
              <tr>
                {canEdit && <th className="cs-pick"><Checkbox checked={sel.all} indeterminate={sel.some} onChange={() => sel.toggleAll()} label="Select every receipt" /></th>}
                <th>Date</th>
                <th>Merchant</th>
                <th className="cs-right">Amount</th>
                <th className="cs-right">{base}</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {list.map(e => (
                <tr key={e.id} className={`cs-row${sel.isSelected(e.id) ? ' is-picked' : ''}`}
                    onClick={ev => { if (!ev.target.closest('a, button, input, label')) navigate(reviewHref(e)); }}>
                  {canEdit && <td className="cs-pick"><Checkbox checked={sel.isSelected(e.id)} onChange={on => sel.toggle(e.id, on)} label={`Select ${nameOf(e)}${e.receiptDate ? `, ${fmtDay(e.receiptDate)}` : ''}`} /></td>}
                  <td className="cs-nowrap">{fmtDay(e.receiptDate)}</td>
                  <td className="cs-merchant">
                    <Link to={reviewHref(e)}>{nameOf(e)}</Link>
                    {allowanceOf(e) && <span className="al-tag">no receipt</span>}
                    <div className="cs-sub">{subOf(e)}</div>
                  </td>
                  <td className="cs-right cs-num cs-nowrap">
                    {Number(e.total) > 0 ? fmtMoney(e.total, e.currency) : <span className="cs-none">—</span>}
                    <TaxLine e={e} />
                  </td>
                  <td className="cs-right cs-nowrap"><Base e={e} /></td>
                  <td className="cs-nowrap"><CheckCell e={e} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {behalf.length > 0 && <div className="cs-foot">‡ includes a cost paid on behalf of {behalf.join(', ')}.</div>}

      {canEdit && sel.count > 0 && (
        <div className="cs-bulk" role="group" aria-label="With the ticked receipts">
          <span className="cs-bulk-count" aria-live="polite">
            {busy === 'check' && progress ? `Checking ${progress.done} of ${progress.of}…` : `${sel.count} selected`}
          </span>
          <button type="button" className="btn btn-primary btn-sm" onClick={checkPicked} disabled={!!busy}>Check</button>
          <Menu label="Move to case…" items={moveItems} disabled={!!busy}
                empty={targets === null ? 'Loading your cases…' : 'You have no other case taking receipts'} />
          <button type="button" className="btn btn-outline btn-sm" onClick={removePicked} disabled={!!busy}>Remove from case</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={sel.clear} disabled={!!busy}>Clear</button>
        </div>
      )}

      {canEdit && <Unfiled caseId={caseId} count={list.length} onFiled={onChanged} />}
    </section>
  );
}

// The tax a receipt kept as printed shows, under its amount: "incl. SST 6%
// 1.58"; a pair at one rate as one ("CGST+SGST 18% 3,969.00"); several as
// "incl. 2 taxes 57.20", each named in the tooltip. "incl." for a tax added
// on top too: the amount above includes it. Nothing for a receipt that
// prints no tax, or one read before receipts kept their rows.
function TaxLine({ e }) {
  const list = taxSummary(e.printed);
  if (!list.length) return null;
  const money = n => fmtMoney(n, e.currency).replace(/^[A-Z]{3} /, '');
  const word = t => `${t.label}${t.rate !== null ? ` ${rateText(t.rate)}` : ''} ${money(t.amount)}`;
  if (list.length === 1) return <span className="pp-taxline">incl. {word(list[0])}</span>;
  const all = list.map(word);
  return (
    <span className="pp-taxline" title={all.join('\n')}>
      incl. {list.length} taxes {money(list.reduce((s, t) => s + t.amount, 0))}
      <span className="sr-only">: {all.join(', ')}</span>
    </span>
  );
}

// The amount in the company's currency, or why there is none yet. A receipt
// with no lines has no amount; calling it "rate pending" sent people looking
// for a missing rate.
function Base({ e }) {
  if (e.status === 'reading') return <span className="cs-none">—</span>;
  if (e.baseTotal != null) return <span className="cs-num">{fmtMoney(e.baseTotal, '')}</span>;
  return <span className="cs-sub is-warn">{(e.lines || []).length ? 'rate pending' : 'no amount yet'}</span>;
}

// Checked, being read, a duplicate, or read and waiting with what the server
// noticed about it (receipts/flags.js). A checked receipt keeps its flags in
// view: the policy's "have a look" flags are for whoever looks over the case
// afterwards, and they used to vanish behind the tick.
function CheckCell({ e }) {
  const state = receiptState(e);
  if (state === 'checked') return <span className="cs-state is-ok"><span aria-hidden="true">✓</span> checked<FlagList compact flags={e.flags} /></span>;
  if (state === 'reading') return <span className="cs-state is-busy">reading</span>;
  if (state === 'duplicate') return <span className="cs-state is-bad">duplicate</span>;
  return (
    <span className="cs-state is-todo">
      <FlagList compact flags={e.flags} />
      to check
    </span>
  );
}

// Receipts that are in no case yet, to bring into this one: what the case
// page offered before cases took receipts as they arrived, and still the way
// in for a receipt added on its own from My receipts.
function Unfiled({ caseId, count, onFiled }) {
  const [loose, setLoose] = useState(null);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const load = useCallback(() => api.get('/expenses?unfiled=1')
    // A duplicate or a receipt claimed on its own cannot be filed; offering
    // it only to be refused says nothing useful.
    .then(d => setLoose((d.expenses || []).filter(e => e.status !== 'duplicate' && !e.claimedAt)))
    .catch(() => setLoose([])), []);
  useEffect(() => { load(); }, [load, count]);
  if (!loose || !loose.length) return null;

  async function file() {
    if (busy || !picked.length) return;
    setBusy(true); setNote(null);
    try {
      const d = await api.post(`/reports/${caseId}/expenses`, { expenseIds: picked });
      const skipped = d.skipped || [];
      setPicked([]);
      await onFiled();
      await load();
      // Anything the server refused comes back in `skipped`; saying nothing
      // made a refusal look like a successful filing.
      if (skipped.length) setNote(`${skipped.length} not added: ${skipped.map(x => x.why).join(', ')}.`);
    } catch (err) { setNote(err.message); }
    finally { setBusy(false); }
  }

  return (
    <details className="cs-loose">
      <summary>Add receipts that are in no case ({loose.length})</summary>
      <ul className="cs-loose-list">
        {loose.map(e => (
          <li key={e.id}>
            <Checkbox checked={picked.includes(e.id)} onChange={on => setPicked(p => (on ? [...p, e.id] : p.filter(x => x !== e.id)))}>
              <span className="cs-loose-name">{fmtDay(e.receiptDate)} · {nameOf(e)}</span>
            </Checkbox>
            <span className="cs-num">{Number(e.total) > 0 ? fmtMoney(e.total, e.currency) : '—'}</span>
          </li>
        ))}
      </ul>
      {note && <div className="alert alert-warning cs-msg" role="status">{note}</div>}
      <button type="button" className="btn btn-outline btn-sm" disabled={!picked.length || busy} onClick={file}>
        {busy ? 'Adding…' : `Add ${picked.length || ''} to this case`}
      </button>
    </details>
  );
}
