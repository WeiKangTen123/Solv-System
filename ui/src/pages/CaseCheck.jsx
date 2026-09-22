import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import StatusBadge from '../components/StatusBadge';
import { fmtMoney } from '../utils/format';

// Checking a whole case in one table.
//
// Thirty receipts from a zip used to mean thirty pages, each with its own load,
// its own scroll and its own save. Here every receipt is a row, the fields the
// reader filled are editable in place, and the receipt itself opens beside the
// row you are on so a figure can be checked against the picture without leaving
// the page.
//
// A receipt split across several categories is not editable here — it needs the
// full page, and the row says so and links to it. Everything else, which is
// almost everything, is one line and belongs in this table.
const FIELDS = ['merchant', 'receiptDate', 'currency', 'total', 'category', 'purpose'];
const pick = e => ({
  merchant: e.merchant ?? '', receiptDate: e.receiptDate ?? '', currency: e.currency ?? '',
  total: e.total ?? '', category: (e.lines && e.lines.length === 1 ? e.lines[0].category : e.category) ?? '',
  purpose: e.purpose ?? '',
});

export default function CaseCheck() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const base = user?.baseCurrency || 'SGD';

  const [view, setView] = useState(null);
  const [rows, setRows] = useState({});          // expenseId -> edited fields
  const [dirty, setDirty] = useState({});        // expenseId -> true
  const [sel, setSel] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [categories, setCategories] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const d = await api.get(`/reports/${id}`);
    setView(d);
    setRows(r => {
      const next = {};
      for (const e of d.report.expenses) next[e.id] = dirtyRef.has(e.id) ? r[e.id] : pick(e);
      return next;
    });
  }, [id]);

  // Which rows the user has touched, kept outside state so a reload can leave
  // them alone without the loader depending on them.
  const [dirtyRef] = useState(() => new Set());

  useEffect(() => { load().catch(e => setMsg({ tone: 'error', text: e.message })); }, [load]);
  useEffect(() => { api.get('/company').then(d => setCategories(d.categories || [])).catch(() => {}); }, []);

  // The receipt for the row being looked at. One request per selection, and
  // only when there is a file to show.
  useEffect(() => {
    let gone = false;
    const e = view?.report?.expenses?.find(x => x.id === sel);
    if (!e || !e.receipt) { setImageUrl(null); return; }
    api.get(`/receipts/${e.receipt.id}/token`)
      .then(d => { if (!gone) setImageUrl(`/api/receipts/${e.receipt.id}/image?token=${encodeURIComponent(d.token)}`); })
      .catch(() => { if (!gone) setImageUrl(null); });
    return () => { gone = true; };
  }, [sel, view]);

  const set = (eid, k, v) => {
    dirtyRef.add(eid);
    setDirty(d => ({ ...d, [eid]: true }));
    setRows(r => ({ ...r, [eid]: { ...r[eid], [k]: v } }));
  };

  async function saveRow(e) {
    const edit = rows[e.id];
    if (!edit || !dirtyRef.has(e.id)) return true;
    try {
      const body = {};
      for (const k of FIELDS) if (k !== 'category') body[k] = edit[k] === '' ? null : edit[k];
      // An empty currency box means "I have not typed it yet", not "this receipt
      // has no currency". Sending it cleared the currency and with it the rate.
      const ccy = String(edit.currency || '').toUpperCase();
      if (/^[A-Z]{3}$/.test(ccy)) body.currency = ccy; else delete body.currency;
      await api.patch(`/expenses/${e.id}`, body);

      const lines = e.lines || [];
      const amount = Number(edit.total);
      if (!lines.length && amount > 0) {
        // A receipt the reader could not make out arrives with no lines at all,
        // and an expense with no lines can never be checked. Typing the total
        // here gives it one, which is the whole point of rescuing it from this
        // table rather than opening its own page.
        await api.put(`/expenses/${e.id}/lines`, {
          lines: [{ category: edit.category || null, description: null, amount, currency: ccy || e.currency || null }],
        });
      } else if (lines.length === 1 && (edit.category !== lines[0].category || Number(lines[0].amount) !== amount)) {
        // The report's column comes from the line, not the expense, so a
        // category typed here has to reach the line or the printed report
        // ignores it.
        await api.put(`/expenses/${e.id}/lines`, {
          lines: [{ ...lines[0], category: edit.category || null, amount: amount > 0 ? amount : lines[0].amount }],
        });
      }
      dirtyRef.delete(e.id);
      setDirty(d => ({ ...d, [e.id]: false }));
      return true;
    } catch (err) {
      setMsg({ tone: 'error', text: `${e.merchant || 'A receipt'}: ${err.message}` });
      return false;
    }
  }

  async function saveAll() {
    setBusy('save');
    try {
      for (const e of view.report.expenses) if (!(await saveRow(e))) return false;
      await load();
      return true;
    } finally { setBusy(''); }
  }

  async function markAll() {
    setMsg(null);
    if (!(await saveAll())) return;
    setBusy('check');
    try {
      const r = await api.post(`/reports/${id}/review-all`, {});
      await load();
      setMsg(r.skipped?.length
        ? { tone: 'warning', text: `${r.reviewed} checked. ${r.skipped.length} could not be: ${r.skipped.map(s => `${s.merchant || 'one receipt'} (${s.why})`).join('; ')}.` }
        : { tone: 'success', text: `All ${r.reviewed} checked. The case is ready to submit.` });
    } catch (err) { setMsg({ tone: 'error', text: err.message }); }
    finally { setBusy(''); }
  }

  if (!view) return <div style={{ color: 'var(--text-muted)' }}>{msg?.text || 'Loading…'}</div>;
  const r = view.report;
  const left = r.expenses.filter(e => e.status !== 'reviewed').length;
  const selected = r.expenses.find(e => e.id === sel) || null;

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            <Link to={`/reports/${id}`} style={{ color: 'inherit' }}>← {r.number}</Link>
          </div>
          <h1>Check {r.expenses.length} receipt{r.expenses.length === 1 ? '' : 's'}</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            {left ? `${left} still need you. ` : 'All checked. '}
            Fix anything the reader got wrong, add the business purpose, then check them all.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" disabled={!!busy} onClick={saveAll}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button className="btn btn-primary" disabled={!!busy || !view.editable} onClick={markAll}>
            {busy === 'check' ? 'Checking…' : 'Check them all'}
          </button>
        </div>
      </div>

      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}
      {!view.editable && <div className="alert alert-info">This case has been {r.status}; nothing can be changed until it is sent back.</div>}

      <div style={{ display: 'grid', gridTemplateColumns: selected ? 'minmax(0, 1fr) 360px' : '1fr', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="data-table check-table">
            <thead>
              <tr>
                <th>Date</th><th>Merchant</th><th>Category</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th style={{ textAlign: 'right' }}>{base}</th>
                <th>Purpose</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {r.expenses.map(e => {
                const row = rows[e.id] || pick(e);
                const many = e.lines && e.lines.length > 1;
                const on = e.id === sel;
                return (
                  <tr key={e.id} onClick={() => setSel(e.id)}
                      style={{ cursor: 'pointer', background: on ? 'var(--bg-hover)' : undefined }}>
                    <td><input className="form-input" type="date" style={{ minWidth: 118 }}
                               disabled={!view.editable} value={row.receiptDate || ''} onChange={ev => set(e.id, 'receiptDate', ev.target.value)} /></td>
                    <td><input className="form-input" style={{ minWidth: 126 }}
                               disabled={!view.editable} value={row.merchant || ''} placeholder="Merchant"
                               onChange={ev => set(e.id, 'merchant', ev.target.value)} /></td>
                    <td>
                      {many
                        ? <Link to={`/expenses/${e.id}`} style={{ fontSize: 12 }}>{e.lines.length} lines →</Link>
                        : <select className="form-input" style={{ minWidth: 118 }}
                                  disabled={!view.editable} value={row.category || ''} onChange={ev => set(e.id, 'category', ev.target.value)}>
                            <option value="">Category…</option>
                            {categories.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <input className="form-input" style={{ width: 50, textTransform: 'uppercase' }}
                             disabled={!view.editable} value={row.currency || ''} maxLength={3} aria-label="Currency"
                             onChange={ev => set(e.id, 'currency', ev.target.value.toUpperCase().slice(0, 3))} />
                      <input className="form-input" type="number" step="0.01" aria-label="Amount"
                             style={{ width: 92, textAlign: 'right', marginLeft: 4, fontFamily: 'var(--font-mono)' }}
                             disabled={!view.editable} value={row.total ?? ''} onChange={ev => set(e.id, 'total', ev.target.value)} />
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                      {e.baseTotal != null ? fmtMoney(e.baseTotal, '') : <span style={{ color: 'var(--warning)' }}>no rate</span>}
                    </td>
                    <td><input className="form-input" style={{ minWidth: 140 }}
                               disabled={!view.editable} value={row.purpose || ''} placeholder="What it was for"
                               onChange={ev => set(e.id, 'purpose', ev.target.value)} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <StatusBadge status={e.status} />
                      {dirty[e.id] && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>edited</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!r.expenses.length && <div style={{ padding: 16, fontSize: 13, color: 'var(--text-muted)' }}>Nothing in this case yet. Add receipts on the case page.</div>}
        </div>

        {selected && (
          <div className="card" style={{ position: 'sticky', top: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{selected.merchant || 'Receipt'}</div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSel(null)} aria-label="Close the receipt">✕</button>
            </div>
            {!imageUrl ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No receipt file for this one.</div>
              : selected.receipt?.mime === 'application/pdf'
                ? <iframe title="Receipt" src={`${imageUrl}#zoom=page-width`} style={{ width: '100%', height: 460, border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
                : <img src={imageUrl} alt="Receipt" style={{ maxWidth: '100%', borderRadius: 8 }} />}
            <button className="btn btn-outline btn-sm" style={{ marginTop: 10 }} onClick={() => navigate(`/expenses/${selected.id}`)}>Open the full page</button>
          </div>
        )}
      </div>
    </div>
  );
}
