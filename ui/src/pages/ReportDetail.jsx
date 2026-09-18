import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import StatusBadge from '../components/StatusBadge';
import ConfirmDialog from '../components/ConfirmDialog';
import { fmtMoney } from '../utils/format';
import { formatDateTime } from '../utils/formatDate';

// The cover, the expenses under it, the totals, and the one action the
// current person can take on it right now.
const COVER = [['title', 'Title', 'text'], ['purpose', 'Purpose', 'text'], ['periodFrom', 'From', 'date'], ['periodTo', 'To', 'date'], ['destination', 'Destination', 'text'], ['nights', 'Nights', 'number'], ['advances', 'Advances received', 'number'], ['notes', 'Notes', 'text']];
const SOURCE = { frankfurter: 'ECB reference rate', 'open.er-api': 'ExchangeRate-API', manual: 'entered', base: 'base currency' };

export default function ReportDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const base = user?.baseCurrency || 'SGD';
  const [view, setView] = useState(null);
  const [cover, setCover] = useState({});
  const [unfiled, setUnfiled] = useState([]);
  const [picked, setPicked] = useState([]);
  const [rejecting, setRejecting] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [preview, setPreview] = useState(null);

  const load = useCallback(async () => {
    const d = await api.get(`/reports/${id}`);
    setView(d);
    setCover(Object.fromEntries(COVER.map(([k]) => [k, d.report[k] ?? ''])));
    if (d.isOwner && d.editable) setUnfiled((await api.get('/expenses?unfiled=1&status=reviewed')).expenses); else setUnfiled([]);
  }, [id]);
  useEffect(() => { setMsg(null); load().catch(e => setMsg({ tone: 'error', text: e.message })); }, [load]);

  const act = async (label, fn) => { setBusy(label); try { await fn(); await load(); } catch (e) { setMsg({ tone: 'error', text: e.message }); } finally { setBusy(''); } };
  async function exportAs(format) {
    try { const d = await api.get(`/reports/${id}/export-url?format=${format}`); window.open(d.url, '_blank', 'noopener'); }
    catch (e) { setMsg({ tone: 'error', text: e.message }); }
  }

  if (!view) return <div style={{ color: 'var(--text-muted)' }}>{msg?.text || 'Loading…'}</div>;
  const { report: r, editable, isOwner, canDecide, xero } = view;
  const canEdit = editable && (isOwner || user?.role === 'admin');
  const rates = [...new Map(r.expenses.flatMap(e => e.lines).filter(l => l.fxRate && l.fxSource !== 'base').map(l => [`${l.currency}|${l.fxRate}|${l.fxRateDate}|${l.fxSource}`, l])).values()];
  const cats = Object.entries(r.totals.byCategory);
  const isFinance = user?.role === 'finance' || user?.role === 'admin';

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}><Link to="/reports" style={{ color: 'inherit' }}>← Reports</Link></div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>{r.number} · {r.title || 'Untitled'} <StatusBadge status={r.status} /></h1>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-sm" onClick={() => exportAs('pdf')}>Export PDF</button>
          <button className="btn btn-outline btn-sm" onClick={() => exportAs('xlsx')}>XLSX</button>
          <button className="btn btn-outline btn-sm" onClick={() => exportAs('csv')}>CSV</button>
          {canEdit && <button className="btn btn-outline btn-sm" onClick={() => setConfirm('delete')}>Delete</button>}
        </div>
      </div>

      {msg && <div className={`alert alert-${msg.tone}`}>{msg.text}</div>}
      {r.status === 'rejected' && <div className="alert alert-warning"><span className="alert-icon">!</span><span>Sent back: {r.rejectedReason}. Fix what was asked, then submit again.</span></div>}
      {r.xeroError && <div className="alert alert-warning"><span className="alert-icon">!</span><span>Xero: {r.xeroError}</span></div>}
      {r.status === 'submitted' && isOwner && <div className="alert alert-info">Submitted {formatDateTime(r.submittedAt, user?.timezone)}. Waiting for approval; nothing can be changed until it is decided.</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 18, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <div className="card">
            <div className="card-title">Cover</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 12px' }}>
              {COVER.map(([k, label, type]) => (
                <div className="form-group" key={k} style={{ gridColumn: k === 'title' || k === 'purpose' || k === 'notes' ? '1 / -1' : 'auto' }}>
                  <label className="form-label" htmlFor={`c-${k}`}>{label}</label>
                  <input id={`c-${k}`} className="form-input" type={type} step={type === 'number' ? '0.01' : undefined} disabled={!canEdit} value={cover[k] ?? ''} onChange={e => setCover({ ...cover, [k]: e.target.value })} />
                </div>
              ))}
            </div>
            {canEdit && <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => act('cover', () => api.patch(`/reports/${id}`, cover))}>{busy === 'cover' ? 'Saving…' : 'Save cover'}</button>}
          </div>

          <div className="card">
            <div className="card-title">Expenses ({r.expenses.length})</div>
            {!r.expenses.length ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nothing filed yet.</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead><tr><th>Date</th><th>Merchant</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>{base}</th><th>Lines</th><th>Status</th><th></th></tr></thead>
                  <tbody>{r.expenses.map(e => (
                    <tr key={e.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{e.receiptDate || '—'}</td>
                      <td><Link to={`/expenses/${e.id}`}>{e.merchant || 'Untitled'}</Link>{e.purpose && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.purpose}</div>}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtMoney(e.total, e.currency)}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: e.fxPending ? 'var(--warning)' : undefined }}>{e.baseTotal != null ? fmtMoney(e.baseTotal, base) : 'rate pending'}</td>
                      <td style={{ fontSize: 12 }}>{e.lines.map(l => `${l.category}${l.onBehalfOf ? ` (${l.onBehalfOf})` : ''}`).join(', ')}</td>
                      <td><StatusBadge status={e.status} /></td>
                      <td>{canEdit && <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => act('rm', () => api.delete(`/reports/${id}/expenses/${e.id}`))}>Remove</button>}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            )}
            {canEdit && unfiled.length > 0 && (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Reviewed expenses not yet in a report</div>
                {unfiled.map(e => (
                  <label key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, padding: '4px 0' }}>
                    <input type="checkbox" checked={picked.includes(e.id)} onChange={ev => setPicked(p => (ev.target.checked ? [...p, e.id] : p.filter(x => x !== e.id)))} />
                    <span style={{ flex: 1 }}>{e.receiptDate || '—'} · {e.merchant || 'Untitled'}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(e.total, e.currency)}</span>
                  </label>
                ))}
                <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} disabled={!picked.length || !!busy} onClick={() => act('file', async () => { await api.post(`/reports/${id}/expenses`, { expenseIds: picked }); setPicked([]); })}>File {picked.length || ''} into this report</button>
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-title">Totals</div>
            {cats.map(([c, v]) => <div key={c} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}><span>{c}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(v, base)}</span></div>)}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0 3px', borderTop: '1px solid var(--border)', marginTop: 6 }}><span>Total</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(r.totals.totalBase, base)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}><span>Advances</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>− {fmtMoney(r.advances, base)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700, padding: '6px 0 0', color: 'var(--accent)' }}><span>Reimbursement</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(r.totals.reimbursement, base)}</span></div>
            {(r.totals.pendingRates > 0 || r.totals.unreviewed > 0) && <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: 8 }}>{r.totals.unreviewed ? `${r.totals.unreviewed} not reviewed. ` : ''}{r.totals.pendingRates ? `${r.totals.pendingRates} without a rate.` : ''}</div>}
          </div>

          <div className="card">
            <div className="card-title">Actions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {isOwner && editable && <button className="btn btn-primary" disabled={!!busy} onClick={() => act('submit', () => api.post(`/reports/${id}/submit`, {}))}>{busy === 'submit' ? 'Submitting…' : 'Submit for approval'}</button>}
              {canDecide && r.status === 'submitted' && <button className="btn btn-primary" disabled={!!busy} onClick={() => act('approve', () => api.post(`/reports/${id}/approve`, {}))}>Approve</button>}
              {canDecide && (r.status === 'submitted' || (r.status === 'approved' && isFinance)) && <button className="btn btn-outline" disabled={!!busy} onClick={() => setRejecting({ reason: '' })}>Send back…</button>}
              {isFinance && r.status === 'approved' && <button className="btn btn-primary" disabled={!!busy} onClick={() => act('paid', () => api.post(`/reports/${id}/paid`, {}))}>Mark paid</button>}
              {isFinance && ['approved', 'paid'].includes(r.status) && !r.xeroInvoiceId && (
                xero?.connected ? (
                  <>
                    <button className="btn btn-outline" disabled={!!busy} onClick={() => act('preview', async () => { setPreview(await api.post(`/reports/${id}/post?dryRun=1`, {})); })}>Preview Xero bill</button>
                    <button className="btn btn-primary" disabled={!!busy} onClick={() => setConfirm('post')}>Post to Xero</button>
                  </>
                ) : <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Connect Xero in Settings to post this report as a bill.</div>
              )}
              {r.xeroInvoiceId && <div style={{ fontSize: 12.5, color: 'var(--success)' }}>In Xero as draft bill {r.xeroInvoiceId}{xero?.tenantName ? ` (${xero.tenantName})` : ''}.</div>}
              {!isOwner && !canDecide && !(isFinance && r.status === 'approved') && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Nothing for you to do on this report right now.</div>}
              {isOwner && !editable && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{r.status === 'submitted' ? 'Waiting for your manager.' : r.status === 'approved' ? 'Approved; finance will pay it.' : r.status === 'paid' ? `Paid ${formatDateTime(r.paidAt, user?.timezone)}.` : ''}</div>}
            </div>
            {preview && (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10, fontSize: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Bill to {preview.bill.contact.name} · {preview.bill.invoice.currencyCode} {fmtMoney(preview.bill.total)} · {preview.tenantName || 'no org'}</div>
                {preview.bill.invoice.lineItems.map((l, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 0', borderTop: '1px solid var(--border)' }}>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description}</span>
                    <span style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{l.accountCode || '—'} · {l.taxType}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtMoney(l.unitAmount)}</span>
                  </div>))}
                <div style={{ color: 'var(--text-muted)', marginTop: 6 }}>Attachments: {preview.bill.attachments.join(', ') || 'none'}</div>
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setPreview(null)}>Close preview</button>
              </div>
            )}
            {rejecting && (
              <form onSubmit={e => { e.preventDefault(); act('reject', () => api.post(`/reports/${id}/reject`, { reason: rejecting.reason })).then(() => setRejecting(null)); }} style={{ marginTop: 10 }}>
                <input id="reject-reason" className="form-input" placeholder="Tell the claimant what to fix" required value={rejecting.reason} onChange={e => setRejecting({ reason: e.target.value })} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-danger btn-sm" type="submit" disabled={!!busy}>Send back</button>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRejecting(null)}>Cancel</button>
                </div>
              </form>
            )}
          </div>

          {rates.length > 0 && (
            <div className="card">
              <div className="card-title">Rates used</div>
              {rates.map(l => <div key={`${l.currency}${l.fxRate}${l.fxRateDate}`} style={{ fontSize: 12, padding: '3px 0' }}>{l.currency} → {base} <strong>{l.fxRate}</strong> <span style={{ color: 'var(--text-muted)' }}>· {SOURCE[l.fxSource] || l.fxSource} {l.fxRateDate}{l.fxOverrideBy ? ` by ${l.fxOverrideBy}` : ''}</span></div>)}
            </div>
          )}

          <div className="card">
            <div className="card-title">History</div>
            {r.events.map(ev => <div key={ev.id} style={{ fontSize: 12, padding: '3px 0', display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>{ev.action}{ev.note ? ` — ${ev.note}` : ''}<span style={{ color: 'var(--text-muted)' }}> · {ev.actorName || ''}</span></span><span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatDateTime(ev.at, user?.timezone)}</span></div>)}
          </div>
        </div>
      </div>

      {confirm === 'post' && <ConfirmDialog title={`Post ${r.number} to Xero?`} message={`A draft bill payable to ${r.ownerName || 'the claimant'} for ${fmtMoney(r.totals.totalBase, base)} will be created in ${xero?.tenantName || 'Xero'}, with the receipts attached. Finance approves it in Xero as usual.`} confirmLabel="Post to Xero"
                                   onConfirm={() => { setConfirm(null); act('post', () => api.post(`/reports/${id}/post`, {})); }} onCancel={() => setConfirm(null)} />}
      {confirm === 'delete' && <ConfirmDialog title="Delete this report?" message="The expenses stay in My expenses; only the report goes." confirmLabel="Delete" danger onConfirm={() => api.delete(`/reports/${id}`).then(() => navigate('/reports')).catch(e => { setConfirm(null); setMsg({ tone: 'error', text: e.message }); })} onCancel={() => setConfirm(null)} />}
    </div>
  );
}
