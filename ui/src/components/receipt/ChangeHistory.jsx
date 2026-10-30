import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { formatDateTime } from '../../utils/formatDate';
import Skeleton from '../ui/Skeleton';

// Who changed what on a receipt (GET /expenses/:id/changes). Changes saved
// together are shown together; the newest five are shown until asked for
// the rest.
//
// ChangeHistory props: items (the changes, newest first, or null while they
// load), all (show every group), onAll, me (the viewer's id: their own
// changes read "You"), tz, bare (no card round it).
const VIA = { assistant: 'through the assistant', reread: 'by re-reading the receipt' };

export default function ChangeHistory({ items, all, onAll, me, tz, bare = false }) {
  if (!items) return null;
  const groups = [];
  for (const c of items) {
    const g = groups[groups.length - 1];
    if (g && g.at === c.at && g.actorId === c.actorId && g.via === c.via) g.rows.push(c);
    else groups.push({ at: c.at, actorId: c.actorId, actorName: c.actorName, actorRole: c.actorRole, via: c.via, rows: [c] });
  }
  const shown = all ? groups : groups.slice(0, 5);
  const body = (
    <>
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
              {/* The rows as printed change many at a time, so the log says the
                  change in one sentence ("SST 6% 1.58 → 1.60 · Added Teh tarik
                  5.60") with nothing before it. */}
              {c.field === 'printed' ? <span>{c.newValue || 'changed'}</span> : (
                <>
                  <span style={{ color: 'var(--text-muted)', textDecoration: c.oldValue ? 'line-through' : 'none' }}>{c.oldValue || 'empty'}</span>
                  {' → '}
                  <span>{c.newValue || 'empty'}</span>
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      {!all && groups.length > 5 && <button type="button" className="btn btn-ghost btn-sm" onClick={onAll}>Show all {groups.length}</button>}
    </>
  );
  if (bare) return body;
  return (
    <div className="card">
      <div className="card-title">Change history</div>
      <div className="card-subtitle">Every change to this receipt&rsquo;s details after it was read, and who made it.</div>
      {body}
    </div>
  );
}

// The same history behind a disclosure, asked for only when it is opened:
// most receipts are checked without anyone looking at it. Give it a `key` of
// the expense id; `version` changes after each save, so an open history
// shows the save that was just made.
export function HistoryDisclosure({ expenseId, version, me, tz }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!open || !expenseId) return undefined;
    let alive = true;
    api.get(`/expenses/${expenseId}/changes`)
      .then(d => { if (alive) setItems(d.changes || []); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [open, expenseId, version]);
  return (
    <details className="rcpt-history" onToggle={e => setOpen(e.currentTarget.open)}>
      <summary>Change history</summary>
      <div className="rcpt-history-body">
        {open && (items ? <ChangeHistory items={items} all={all} onAll={() => setAll(true)} me={me} tz={tz} bare /> : <Skeleton rows={2} label="Loading the history" />)}
      </div>
    </details>
  );
}
