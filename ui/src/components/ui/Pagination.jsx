// Under a long list: "1–20 of 34", and Previous / Next. It counts rows, not
// pages, because the server pages by offset (GET /reports?limit=&offset=) and
// "page 2 of 2" says less than which rows are on screen. The range is a live
// region, so moving on is announced. With everything on one page only the
// count shows; with nothing, nothing.
//
// An offset past the end (the last row of the last page was just deleted)
// shows the last page instead of "35–34 of 34"; the page should load that
// page too, and onChange with Previous gets it there.
//
// Props:
//   total     how many rows there are in all.
//   limit     rows per page.
//   offset    index of the first row on screen.
//   onChange  fn(newOffset).
//   label     aria-label for the navigation (default "Pages").
export default function Pagination({ total, limit, offset, onChange, label = 'Pages' }) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  if (!n) return null;
  const size = Math.max(1, Math.floor(Number(limit) || 1));
  let at = Math.max(0, Math.floor(Number(offset) || 0));
  if (at >= n) at = Math.floor((n - 1) / size) * size;
  const last = Math.min(at + size, n);
  const f = x => x.toLocaleString();

  return (
    <nav className="ui-pager" aria-label={label}>
      <span className="ui-pager-range" aria-live="polite">
        {at + 1 === last ? f(last) : `${f(at + 1)}–${f(last)}`} of {f(n)}
      </span>
      {n > size && (
        <span className="ui-pager-buttons">
          <button type="button" className="btn btn-outline btn-sm" disabled={at === 0} aria-label="Previous page"
                  onClick={() => onChange?.(Math.max(0, at - size))}>
            <span aria-hidden="true">‹</span> Previous
          </button>
          <button type="button" className="btn btn-outline btn-sm" disabled={last >= n} aria-label="Next page"
                  onClick={() => onChange?.(at + size)}>
            Next <span aria-hidden="true">›</span>
          </button>
        </span>
      )}
    </nav>
  );
}
