// A bar that fills as work gets done: "12 of 40 read". It is a real
// role=progressbar, so a screen reader can ask how far along it is; the words
// beside it are the page's to write. With no `value` yet it is indeterminate,
// a slow sweep that stands still under reduced motion.
//
// Props:
//   value      how much is done; null or undefined while unknown.
//   max        how much there is in all (default 100). 0 reads as empty.
//   label      accessible name ("Receipts read"); required, since a bar has
//              no words of its own.
//   valueText  optional spoken value ("12 of 40 read") instead of a percentage.
//   tone       optional status colour: 'info' (in progress), 'success',
//              'warning', 'danger'. Without one the bar is ink, like the
//              primary button, because a bar is not a status by itself.
export default function ProgressBar({ value, max = 100, label, valueText, tone }) {
  const top = Number(max) > 0 ? Number(max) : 0;
  const known = value !== null && value !== undefined && Number.isFinite(Number(value));
  const now = known ? Math.min(Math.max(Number(value), 0), top) : null;
  const pct = known && top ? (now / top) * 100 : 0;
  const cls = ['ui-progress', tone && `ui-progress-${tone}`, !known && 'is-indeterminate'].filter(Boolean).join(' ');
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={top}
         aria-valuenow={known ? now : undefined} aria-valuetext={valueText} className={cls}>
      <div className="ui-progress-fill" style={known ? { width: `${pct}%` } : undefined} />
    </div>
  );
}
