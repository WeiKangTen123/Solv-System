import { fmtRate } from '../../utils/format';

// One currency's daily rate over a month or three, drawn by hand in SVG like
// the dashboard's charts: the content security policy allows this origin's
// scripts only, and thirty to ninety points need no library.
//
// Drawn as steps, not a smooth line: a day's rate holds until the next one is
// published, which is exactly how a receipt dated on a weekend is priced (at
// Friday's). A curve would show highs and lows that never happened. The scale
// fits the range, not zero, because an exchange rate never goes near zero and
// a zero baseline would flatten every move into a straight line.
//
// Colour means state in this app, so the line is ink. A rate an admin set is
// a hollow ring; today's live figure, not yet closed, a small solid dot.

// Drawn at the size it is shown, so its text stays readable: a 640-wide
// drawing shrunk onto a phone made the labels six pixels high.
const SIZES = { wide: { W: 640, H: 190, font: 10.5 }, compact: { W: 360, H: 170, font: 10.5 } };
const DAY = 86400000;

const dayMs = iso => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
const fmtAxisDay = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// The entries in the range, oldest first, and the figures the header shows.
export function rangeOf(entries, days, today) {
  const end = dayMs(today);
  const start = end - (days - 1) * DAY;
  const points = (entries || [])
    .filter(e => e && e.rate > 0 && dayMs(e.date) >= start && dayMs(e.date) <= end)
    .map(e => ({ t: dayMs(e.date), date: e.date, rate: e.rate, kind: e.kind }))
    .sort((a, b) => a.t - b.t);
  if (!points.length) return { points, start, end, high: null, low: null, avg: null };
  const rates = points.map(p => p.rate);
  return {
    points, start, end,
    high: Math.max(...rates), low: Math.min(...rates), avg: rates.reduce((s, r) => s + r, 0) / rates.length,
  };
}

export default function RateChart({ entries, days, today, currency, base, compact = false }) {
  const { W, H, font } = SIZES[compact ? 'compact' : 'wide'];
  const { points, start, end, high, low } = rangeOf(entries, days, today);
  if (points.length < 2) {
    return (
      <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--text-muted)', border: '1px dashed var(--border)', borderRadius: 10 }}>
        {points.length ? 'One day so far — the chart fills in as days close.' : `No ${currency} rates in this range yet.`}
      </div>
    );
  }

  // A flat range still gets a band to sit in.
  const spread = high - low || high * 0.01;
  const yMin = low - spread * 0.12, yMax = high + spread * 0.12;
  const ticksY = [high, (high + low) / 2, low];
  // Room on the left for the longest rate printed there, in the mono face.
  const PAD = { top: 12, right: 12, bottom: 24, left: Math.max(44, Math.max(...ticksY.map(v => fmtRate(v).length)) * font * 0.62 + 12) };
  const x = t => PAD.left + ((t - start) / Math.max(DAY, end - start)) * (W - PAD.left - PAD.right);
  const y = r => PAD.top + (1 - (r - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  // Step after: hold each day's rate until the next one.
  let d = `M${x(points[0].t).toFixed(1)},${y(points[0].rate).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) d += ` H${x(points[i].t).toFixed(1)} V${y(points[i].rate).toFixed(1)}`;

  const ticksX = compact ? [start, end] : [start, start + (end - start) / 2, end];
  const label = `${currency} to ${base}, ${days} days: from ${fmtRate(low)} to ${fmtRate(high)}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={label}>
      <title>{label}</title>
      {ticksY.map((v, i) => (
        <g key={`y${i}`}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} style={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: i === 1 ? '3 4' : undefined }} />
          <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" style={{ fontSize: font, fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{fmtRate(v)}</text>
        </g>
      ))}
      {ticksX.map((t, i) => (
        <text key={`x${i}`} x={x(t)} y={H - 7} textAnchor={i === 0 ? 'start' : i === ticksX.length - 1 ? 'end' : 'middle'} style={{ fontSize: font, fill: 'var(--text-muted)' }}>{fmtAxisDay(t)}</text>
      ))}
      <path d={d} style={{ fill: 'none', stroke: 'var(--accent)', strokeWidth: 1.75, strokeLinejoin: 'round' }} />
      {points.filter(p => p.kind === 'manual').map(p => (
        <circle key={`m${p.date}`} cx={x(p.t)} cy={y(p.rate)} r={4} style={{ fill: 'var(--bg-card)', stroke: 'var(--accent)', strokeWidth: 1.5 }}>
          <title>{`${p.date}: ${fmtRate(p.rate)}, set by an admin`}</title>
        </circle>
      ))}
      {points.filter(p => p.kind === 'live').map(p => (
        <circle key={`l${p.date}`} cx={x(p.t)} cy={y(p.rate)} r={3} style={{ fill: 'var(--accent)' }}>
          <title>{`Today, live: ${fmtRate(p.rate)} (closes tonight)`}</title>
        </circle>
      ))}
    </svg>
  );
}
