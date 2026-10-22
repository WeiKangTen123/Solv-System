// The decisions behind the intake panel that are not drawing: which route a
// dropped file goes to, how a file's progress reads, how the files the page
// sent line up with the files the server holds, and the counts line.
//
// No imports, so main/scripts/ui-intake-logic.test.js can load it from source.

const MB = 1024 * 1024;
// A zip goes up as base64 inside JSON, a third bigger, and the routes take a
// 25 MB body: a little over 18 MB of zip. The claim import counts the files
// themselves and stops at 18 MB (routes/claims.js MAX_UPLOAD_BYTES).
export const ZIP_MAX_BYTES = 18 * MB;
export const CLAIM_MAX_BYTES = 18 * MB;

const ACCEPTED_WORDS = 'photos (JPEG, PNG, HEIC, WebP, TIFF, GIF, AVIF, BMP), PDF, a zip of receipts, or an .xlsx claim form';
const RECEIPT_EXT = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'tif', 'tiff', 'avif', 'webp', 'gif', 'bmp', 'pdf']);

const extOf = name => { const m = /\.([a-z0-9]+)$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
const mb = n => `${(n / MB).toFixed(1)} MB`;

// What a dropped file is to the page: a receipt to upload, a zip of receipts,
// a claim form, or something refused here (with why), before any of it is
// sent. A file with no type and no extension is tried as a receipt: whether
// it is a picture is the browser's to find out when it draws it.
export function kindOf(file) {
  const name = String((file && file.name) || '');
  const type = String((file && file.type) || '').toLowerCase();
  const ext = extOf(name);
  if (file && file.size === 0) {
    return { kind: 'refused', why: 'This file is empty. If it lives in iCloud Drive, OneDrive or a network folder, open it once so it downloads, then add it again.' };
  }
  if (ext === 'zip' || /zip/.test(type)) return { kind: 'zip' };
  if (ext === 'xlsx' || type.includes('spreadsheetml')) return { kind: 'form' };
  if (ext === 'xls') return { kind: 'refused', why: 'An .xls claim form cannot be read. Open it in Excel and save it as .xlsx.' };
  if (ext === 'eml' || ext === 'msg') return { kind: 'refused', why: 'Emails are not read yet. Save the receipt attached to it and add that.' };
  if (type.startsWith('image/') || type === 'application/pdf' || RECEIPT_EXT.has(ext)) return { kind: 'receipt' };
  if (!type && !ext) return { kind: 'receipt' };
  return { kind: 'refused', why: `Not a receipt file. Accepted: ${ACCEPTED_WORDS}.` };
}

// One drop, sorted by where each file goes. A claim form in the drop makes
// the drop a claim: the form and every zip with it go to the claim import
// together, which matches the form's rows to the receipts in the zips. Zips
// without a form are unpacked into the case one by one, and everything else
// is a receipt of its own.
//
// Returns { receipts: File[], zips: File[], claim: { archives, forms } | null,
// refused: [{ file, why, state }] }, `state` being 'unsupported' or 'too-big'.
export function planDrop(files) {
  const out = { receipts: [], zips: [], claim: null, refused: [] };
  const zips = [], forms = [];
  for (const file of Array.from(files || [])) {
    const k = kindOf(file);
    if (k.kind === 'refused') out.refused.push({ file, why: k.why, state: 'unsupported' });
    else if (k.kind === 'zip') zips.push(file);
    else if (k.kind === 'form') forms.push(file);
    else out.receipts.push(file);
  }
  if (forms.length) {
    const bytes = [...zips, ...forms].reduce((s, f) => s + (f.size || 0), 0);
    if (bytes > CLAIM_MAX_BYTES) {
      for (const file of [...forms, ...zips]) {
        out.refused.push({ file, state: 'too-big', why: `This claim is ${mb(bytes)} with its zips; an import takes up to ${mb(CLAIM_MAX_BYTES)}. Split the zip, or add the receipts themselves.` });
      }
    } else {
      out.claim = { archives: zips, forms };
    }
    return out;
  }
  for (const file of zips) {
    if (file.size > ZIP_MAX_BYTES) out.refused.push({ file, state: 'too-big', why: `This zip is ${mb(file.size)}; a zip can be up to ${mb(ZIP_MAX_BYTES)}. Split it in two, or add the receipts themselves.` });
    else out.zips.push(file);
  }
  return out;
}

// Whether a receipt has an amount to show. A read that made nothing out
// leaves the total at 0 with the server's no-amount flag on it, and "SGD
// 0.00" beside it read as a receipt for nothing.
export function hasAmount(e) {
  if (!e || e.total === null || e.total === undefined) return false;
  return !(e.flags || []).some(f => f.code === 'no-amount');
}

// "0:40", "12:05": a wait that counts down on screen.
export function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// The server's estimate of the reading left, said as a person would.
export function fmtEta(seconds) {
  const s = Number(seconds) || 0;
  if (s <= 0) return '';
  if (s < 60) return 'less than a minute left';
  return `about ${Math.round(s / 60)} min left`;
}

const ms = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

// A read put off by the queue: the AI was busy (or a read failed once) and it
// tries again by itself at `nextAt`.
export function waitingRetry(read, now) {
  return !!read && read.state === 'queued' && !!read.errorKind && ms(read.nextAt) > now;
}

const LOCAL_UPLOADING = new Set(['queued', 'preparing', 'uploading']);
const LOCAL_PROBLEM = new Set(['duplicate', 'unsupported', 'too-big', 'failed']);
const CLAIM_ENDED = new Set(['done', 'failed', 'cancelled', 'gone']);

// Which of the counts line's groups a row is in:
//   uploading  still on its way from this page;
//   reading    on the server, waiting for the reader or being read;
//   waiting    put off because the AI was busy, tried again by itself;
//   read       through the reader;
//   needYou    the person has something to do: a refused or failed file, a
//              duplicate, a read that failed, was stopped, or made nothing
//              out (it will have to be typed in).
// A row is { local, file }: what this page sent, what the server holds.
const blank = e => !e.merchant && !hasAmount(e);
export function bucketOf(row, now) {
  const { local, file } = row || {};
  if (file) {
    const read = file.read;
    const ex = file.expenses || [];
    const dup = ex.some(e => e.status === 'duplicate');
    if (!read || read.state === 'done') return dup || (ex.length && ex.every(blank)) ? 'needYou' : 'read';
    if (read.state === 'queued') return waitingRetry(read, now) ? 'waiting' : 'reading';
    if (read.state === 'reading') return 'reading';
    return 'needYou';
  }
  if (!local) return 'read';
  if (local.kind === 'claim' && local.state === 'claim') {
    const stage = local.job && local.job.stage;
    if (!CLAIM_ENDED.has(stage)) return 'reading';
    return stage === 'done' ? 'read' : 'needYou';
  }
  if (LOCAL_UPLOADING.has(local.state)) return 'uploading';
  if (LOCAL_PROBLEM.has(local.state)) return 'needYou';
  return 'reading';   // stored, and the server has not said more yet
}

// A finished claim import is not counted: the receipts it brought are rows
// of their own, and counting the import as well would count its files twice.
export const isDoneClaim = r => !!(r && !r.file && r.local && r.local.kind === 'claim' && r.local.job && r.local.job.stage === 'done');

export function countRows(rows, now) {
  const c = { files: 0, uploading: 0, reading: 0, waiting: 0, read: 0, needYou: 0 };
  for (const r of rows || []) {
    if (isDoneClaim(r)) continue;
    c.files++;
    c[bucketOf(r, now)]++;
  }
  return c;
}

// "15 files: 11 read, 2 reading, 2 need you". Empty groups are left out.
export function countsLine(c) {
  if (!c || !c.files) return '';
  const parts = [
    c.read ? `${c.read} read` : '',
    c.uploading ? `${c.uploading} uploading` : '',
    c.reading ? `${c.reading} reading` : '',
    c.waiting ? `${c.waiting} waiting for the AI` : '',
    c.needYou ? `${c.needYou} need${c.needYou === 1 ? 's' : ''} you` : '',
  ].filter(Boolean);
  return `${c.files} file${c.files === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

// The page's own rows and the server's files as one list. The server's come
// first, in the order they arrived, each with the row this page sent it from
// if there is one (matched by receipt id); then what this page still holds on
// its own: files on their way, refused, or failed. A file stored before the
// last answer was asked for and missing from it has left the case (removed,
// or moved to another), and is no longer shown.
//
// Keys stay with a row for its whole life on the page, so a file does not
// lose its place (or its open list of receipts) when the server first
// reports it.
export function mergeRows(localRows, serverFiles, { polledAt = 0 } = {}) {
  const files = Array.isArray(serverFiles) ? serverFiles : [];
  const held = new Set(files.map(f => f.receiptId));
  const mine = new Map();
  for (const l of localRows || []) if (l.receiptId) mine.set(l.receiptId, l);
  const out = files.map(f => {
    const local = mine.get(f.receiptId) || null;
    return { key: local ? `l:${local.id}` : `r:${f.receiptId}`, local, file: f };
  });
  for (const l of localRows || []) {
    if (l.receiptId && held.has(l.receiptId)) continue;
    if (l.receiptId && polledAt && l.storedAt && l.storedAt < polledAt) continue;
    out.push({ key: `l:${l.id}`, local: l, file: null });
  }
  return out;
}

// When the panel should next ask the server, in ms: every 2 s while a file
// is on its way or a read is due or running; otherwise when the soonest
// put-off read is due, but at least every 20 s. A read put off for an hour
// does not need asking about every 2 s for that hour.
export function pollEvery({ uploading = 0, files = [] } = {}, now) {
  if (uploading > 0) return 2000;
  let due = Infinity;
  for (const f of files) {
    const read = f.read;
    if (!read) continue;
    if (read.state === 'reading') return 2000;
    if (read.state === 'queued') due = Math.min(due, ms(read.nextAt) - now);
  }
  if (due === Infinity) return 20000;
  return Math.min(20000, Math.max(2000, due));
}
