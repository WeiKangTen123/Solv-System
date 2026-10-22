import { useEffect, useId, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';
import Modal from '../Modal';
import { fmtDateRange } from '../../utils/format';

// "Merge into another case…": two cases that turned out to be one trip. The
// owner picks which of their other open cases takes this one's receipts
// (POST /reports/:id/merge { into }); the target's history says where they
// came from, and this case is deleted.
//
// Props:
//   report    the case being merged away: id, number, title, expenses.
//   onMerged  fn(targetId), once the server has done it.
//   onClose   fn().
export default function MergeDialog({ report, onMerged, onClose }) {
  const uid = useId().replace(/:/g, '');
  const [cases, setCases] = useState(null);
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.get('/reports?status=open')
      .then(d => { if (alive) setCases((d.reports || []).filter(c => c.id !== report.id)); })
      .catch(err => { if (alive) { setCases([]); setError(err.message); } });
    return () => { alive = false; };
  }, [report.id]);

  async function merge() {
    if (busy || !into) return;
    setBusy(true); setError('');
    try {
      await api.post(`/reports/${report.id}/merge`, { into });
      onMerged(into);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const n = (report.expenses || []).length;
  const target = cases && cases.find(c => c.id === into);
  return (
    <Modal onClose={onClose} busy={busy} maxWidth={520} labelledBy={`${uid}-title`}>
      <div id={`${uid}-title`} className="cs-dialog-title">Merge {report.number || 'this case'} into another case</div>
      <p className="cs-dialog-text">
        {n ? `Its ${n} receipt${n === 1 ? '' : 's'} move to the case you pick` : 'Nothing moves: it has no receipts'}, and {report.number || 'this case'} is deleted.
        The other case&rsquo;s history records the merge.
      </p>

      {!cases ? <div className="cs-sub">Loading your open cases…</div>
        : !cases.length ? <div className="cs-sub">You have no other open case to merge into.</div>
        : (
          <fieldset className="cs-pick-list">
            <legend className="sr-only">Merge into</legend>
            {cases.map(c => (
              <label key={c.id} className={`cs-pick-item${into === c.id ? ' is-on' : ''}`}>
                <input type="radio" name={`${uid}-into`} value={c.id} checked={into === c.id} onChange={() => setInto(c.id)} disabled={busy} />
                <span className="cs-pick-text">
                  <span className="cs-pick-name">{c.number} · {c.title || 'Untitled'}</span>
                  <span className="cs-sub">
                    {[c.periodFrom || c.periodTo ? fmtDateRange(c.periodFrom, c.periodTo) : '', `${c.expenseCount} receipt${c.expenseCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}

      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="cs-dialog-buttons">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={merge} disabled={busy || !into} aria-busy={busy}>
          {busy ? 'Merging…' : target ? `Merge into ${target.number}` : 'Merge'}
        </button>
      </div>
    </Modal>
  );
}
