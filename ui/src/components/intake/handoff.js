// Files handed to the New case page from another page. Home and My receipts
// take a drop of receipts, but a receipt now starts its life in a case, and
// the New case page is where one is made: they hand the files over here and
// go to /reports/new, which takes them on arrival and uploads them.
//
//   setPendingFiles(files); navigate('/reports/new');
//
// A File cannot go in the address or in history state, so it waits in this
// module. It is taken once: a reload, or coming back to the page later, must
// not upload the same files again.
let pending = [];

export function setPendingFiles(files) {
  pending = Array.from(files || []);
}

export function takePendingFiles() {
  const out = pending;
  pending = [];
  return out;
}

export function hasPendingFiles() {
  return pending.length > 0;
}
