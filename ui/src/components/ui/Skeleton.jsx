// Grey bars where content is about to be, while it loads. They hold the shape
// of the page so it does not jump when the answer lands, and unlike "Loading…"
// they never read as an answer. Uses the .skeleton shimmer in globals.css,
// which stands still for anyone who has asked for reduced motion.
//
// A screen reader hears "Loading" once (role=status), not one announcement per
// bar.
//
// Props:
//   rows    how many bars (default 3). The last is shorter, as the last line
//           of a paragraph is.
//   height  height of each bar in px (default 14); use ~44 for table rows.
//   gap     space between bars in px (default 10).
//   label   what a screen reader hears (default "Loading").
export default function Skeleton({ rows = 3, height = 14, gap = 10, label = 'Loading' }) {
  const n = Math.max(1, Number(rows) || 1);
  return (
    <div className="ui-skeleton" role="status" style={{ gap }}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skeleton" aria-hidden="true"
             style={{ height, width: n > 1 && i === n - 1 ? '62%' : '100%' }} />
      ))}
    </div>
  );
}
