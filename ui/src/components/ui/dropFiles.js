// Files out of a drag and drop, for DropZone and useWindowDrop.
//
// A dropped folder arrives as one entry with no bytes in dataTransfer.files,
// so a folder of receipts used to become a single "unsupported file". Where
// the browser offers the entries API (all current ones do), folders are walked
// and their files come out instead. The walk skips the files an operating
// system leaves in folders by itself (.DS_Store, Thumbs.db, desktop.ini): they
// are not anyone's receipts and would only show up as refused rows.
//
// Everything else is passed on, wanted type or not. Whether a file can be a
// receipt is the uploader's call, so it can say which file it refused and why
// instead of the file disappearing.

const JUNK = /^(\..*|thumbs\.db|desktop\.ini)$/i;

// A drag that carries files from outside the page, as opposed to text or a
// link being dragged around inside it.
export function hasFiles(dataTransfer) {
  const types = dataTransfer && dataTransfer.types;
  return !!types && Array.from(types).includes('Files');
}

function readAll(dirReader) {
  // readEntries answers in batches (100 at a time in Chrome) until it answers
  // with none.
  return new Promise((resolve) => {
    const out = [];
    const next = () => dirReader.readEntries(batch => {
      if (!batch.length) { resolve(out); return; }
      out.push(...batch);
      next();
    }, () => resolve(out));
    next();
  });
}

async function walk(entry) {
  if (entry.isFile) {
    if (JUNK.test(entry.name)) return [];
    return new Promise(resolve => entry.file(f => resolve([f]), () => resolve([])));
  }
  if (!entry.isDirectory) return [];
  const children = await readAll(entry.createReader());
  const nested = await Promise.all(children.map(walk));
  return nested.flat();
}

// Must be called inside the drop event itself: the browser empties
// dataTransfer as soon as the handler returns, so the entries are taken here
// synchronously and only read afterwards. Resolves to File[].
export function filesFromDrop(dataTransfer) {
  if (!dataTransfer) return Promise.resolve([]);
  const items = Array.from(dataTransfer.items || []).filter(it => it.kind === 'file');
  const entries = items.map(it => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null));
  if (!entries.some(e => e && e.isDirectory)) return Promise.resolve(Array.from(dataTransfer.files || []));
  // A mixed drop keeps its order: a loose file where it was, a folder's
  // files in its place.
  const now = items.map((it, i) => (entries[i] && entries[i].isDirectory ? entries[i] : it.getAsFile()));
  return Promise.all(now.map(x => (x && x.isDirectory ? walk(x) : Promise.resolve(x ? [x] : []))))
    .then(lists => lists.flat());
}
