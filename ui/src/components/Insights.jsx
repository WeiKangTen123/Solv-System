import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { fmtMoney, fmtMoneyShort } from '../utils/format';

// Where the money goes. Every figure comes from GET /api/dashboard/summary,
// which aggregates in SQL and scopes to what the caller may see — their own
// expenses, a manager's team, the company for finance and admin. Nothing here
// decides who sees what; it only draws what it was given.
//
// The drawings are hand-written SVG and CSS bars. The content security policy
// allows scripts from this origin only, so a charting library would have to be
// bundled, and four shapes is not worth a dependency.

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = key => MONTH[Number(String(key).slice(5, 7)) - 1] || key;

// Six bars and a baseline. Sized by viewBox so it scales with the card instead
// of being measured in pixels that stop being right on a phone.
function Bars({ months, base }) {
  const W = 320, H = 96, PAD = 2;
  const max = Math.max(...months.map(m => m.base), 1);
  const slot = W / months.length;
  const bw = slot - 14;
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} style={{ width: '100%', height: 'auto', display: 'block' }}
         role="img" aria-label={`Spend for the last ${months.length} months, ending ${fmtMoney(months[months.length - 1].base, base)}`}>
      {months.map((m, i) => {
        const h = Math.max(m.base > 0 ? 2 : 0, Math.round((m.base / max) * (H - PAD)));
        const x = i * slot + (slot - bw) / 2;
        const last = i === months.length - 1;
        return (
          <g key={m.month}>
            {/* The current month in the accent, the rest quiet behind it. A
                surface token was too close to the card to read as a bar at
                all, so the earlier months are muted ink instead. */}
            <rect x={x} y={H - h} width={bw} height={h} rx="2"
                  style={{ fill: last ? 'var(--accent)' : 'var(--text-muted)', opacity: last ? 1 : 0.32 }} />
            <text x={x + bw / 2} y={H + 13} textAnchor="middle"
                  style={{ fontSize: 10, fill: 'var(--text-muted)', fontFamily: 'var(--font-sans)' }}>{monthLabel(m.month)}</text>
          </g>
        );
      })}
      <line x1="0" y1={H + 0.5} x2={W} y2={H + 0.5} style={{ stroke: 'var(--border)', strokeWidth: 1 }} />
    </svg>
  );
}

// A labelled proportion. Used for both categories and currencies: same shape,
// so the two cards read as one idea seen twice rather than two designs.
function Share({ rows, base, empty }) {
  if (!rows.length) return <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{empty}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {rows.map(r => (
        <div key={r.key}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5, marginBottom: 3 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.key}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>{fmtMoney(r.base, '')}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', width: 38, textAlign: 'right' }}>
              {Math.round(r.share * 100)}%
            </span>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-input)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(r.share * 100, 1)}%`, height: '100%', borderRadius: 3, background: 'var(--accent)' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const SCOPE = { own: 'your expenses', team: 'you and your team', company: 'the whole company' };

// `refresh` changes when something on the page has actually altered the
// figures. Deliberately not tied to the home page's polling: these are SQL
// aggregates over the company, and re-running them every twenty seconds to
// find nothing changed is a cost with no reader.
export default function Insights({ refresh = 0 }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.get('/dashboard/summary').then(setD).catch(e => setErr(e.message)); }, [refresh]);

  if (err) return <div className="card"><div className="card-title">Where the money goes</div><div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Could not load the figures: {err}</div></div>;
  if (!d) return null;

  const base = d.base;
  // Nothing priced in six months is not a chart, it is a sentence.
  if (!d.total) {
    return (
      <div className="card">
        <div className="card-title">Where the money goes</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Nothing recorded in the last {d.monthsCovered} months yet. Add a receipt and this fills in.
        </div>
      </div>
    );
  }

  // Against a month with nothing in it, "up 100%" would be arithmetic rather
  // than information, so the comparison is simply not offered.
  const change = d.lastMonth > 0 ? (d.thisMonth - d.lastMonth) / d.lastMonth : null;
  const cats = d.byCategory.slice(0, 5).map(c => ({ key: c.category, base: c.base, share: c.share }));
  const ccys = d.byCurrency.slice(0, 5).map(c => ({ key: c.currency, base: c.base, share: c.share }));
  const cyc = d.cycle;

  return (
    <>
      <div className="section-label">Where the money goes · {SCOPE[d.scope] || d.scope}</div>
      <div className="grid-pair" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-title">Last {d.monthsCovered} months</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}>{fmtMoney(d.thisMonth, base)}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>this month</span>
            {change !== null && (
              <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: change > 0 ? 'var(--warning)' : 'var(--success)' }}>
                {change > 0 ? '+' : ''}{Math.round(change * 100)}% on {monthLabel(d.months[d.months.length - 2].month)}
              </span>
            )}
          </div>
          <Bars months={d.months} base={base} />
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
            {fmtMoneyShort(d.total, base)} in total, by receipt date
            {d.unpricedLines > 0 && <span style={{ color: 'var(--warning)' }}> · {d.unpricedLines} line{d.unpricedLines > 1 ? 's' : ''} not counted, still waiting for a rate</span>}
          </div>
        </div>

        <div className="card">
          <div className="card-title">By category</div>
          <div className="card-subtitle">What the money was actually spent on.</div>
          <Share rows={cats} base={base} empty="Nothing categorised yet." />
        </div>

        <div className="card">
          <div className="card-title">Currencies claimed</div>
          <div className="card-subtitle">Shared out by what each came to in {base}.</div>
          <Share rows={ccys} base={base} empty="Nothing claimed yet." />
        </div>

        <div className="card">
          <div className="card-title">How long it takes</div>
          <div className="card-subtitle">From a case being opened to it being claimed.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
            {[
              ['Open → claimed', cyc.openToClaimed, cyc.claimedCount],
            ].map(([label, days, n]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
                <span style={{ flex: 1 }}>{label}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {days === null ? '—' : days < 1 ? 'same day' : `${days} day${days === 1 ? '' : 's'}`}
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)', width: 64, textAlign: 'right' }}>
                  {n ? `over ${n}` : 'none yet'}
                </span>
              </div>
            ))}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 9, display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1 }}>Still open{cyc.openCount ? ` · ${cyc.openCount} case${cyc.openCount === 1 ? '' : 's'}` : ''}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmtMoney(d.open, base)}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
