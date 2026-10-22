const { HttpError } = require('../utils/http-error');
const { sniff, KEEP, CONVERT } = require('./convert');
const { loadSharp } = require('../receipts/load-sharp');

// What an email becomes on the way in: its receipts.
//
// An email reaches Solv two ways: as an .eml or Outlook .msg file dropped on a
// case (routes/receipts.js, POST /email), or forwarded to a person's own
// address and posted here by the mail provider (routes/inbound.js). Either way
// its receipts are its attachments, PDFs and pictures, each stored as if it
// had been dropped by itself, so it is converted, checked for a duplicate and
// read the same way. Pictures that are part of the message's look (a logo, a
// signature, a tracking pixel) are left out, and each thing left out says why.
//
// A mail with no receipt attached is usually the receipt itself: Grab, an
// airline or a hotel types it into the message. It is then kept as a PDF of
// the message, which the reader reads like any typed PDF.
//
// The bytes decide what a mail and an attachment are, as for every file
// (intake/convert.js); a name or a declared type only says what was refused.

const NOT_A_MAIL = 'That file is not an email (.eml or .msg).';
// Outlook saves a message in the compound-file container Word and Excel once
// used; it is told apart by these eight bytes. Everything else is read as
// MIME, which is what every other mail program writes.
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
function isMsg(buffer) { return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(OLE_MAGIC); }

// A text file, a PDF or a photo parses as MIME too, as a body with no
// headers. A mail has at least one of these.
const MAIL_HEADERS = ['from', 'to', 'subject', 'date', 'message-id'];

// Returns { subject, from, fromName, to: [address], date, attachments:
// [{ filename, contentType, content, cid, inline }], text, html }. `from` and
// `to` are bare addresses; `to` holds the Cc as well, every visible recipient.
// `inline` is true for a picture the HTML shows by its cid. Throws an
// HttpError(400) when the bytes are not a mail.
async function parseMail(buffer, { filename = null } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(400, NOT_A_MAIL);
  const mail = isMsg(buffer) ? _readMsg(buffer) : await _readEml(buffer);
  if (!mail) throw new HttpError(400, NOT_A_MAIL);
  return mail;
}

async function _readEml(buffer) {
  let m;
  try {
    // cid: links are kept as written, so a picture the message shows can be
    // told from one attached to it; the parser would otherwise inline every
    // one of them into the HTML as a data: URL. Its own HTML-to-text is off:
    // it runs a receipt's table cells together ("FareS$12.30Total"), and
    // htmlToText below keeps a row to a line.
    m = await require('mailparser').simpleParser(buffer, { keepCidLinks: true, skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true });
  } catch {
    return null;
  }
  if (!m.headers || !MAIL_HEADERS.some(h => m.headers.has(h))) return null;
  const html = typeof m.html === 'string' && m.html ? m.html : null;
  const shown = _cidsShown(html);
  const from = _addresses(m.from)[0] || null;
  return {
    subject: _str(m.subject),
    from: from ? from.address : null,
    fromName: from ? from.name : null,
    to: [..._addresses(m.to), ..._addresses(m.cc)].map(a => a.address),
    date: _date(m.date),
    attachments: (m.attachments || []).map(a => ({
      filename: a.filename || null,
      contentType: a.contentType ? String(a.contentType).toLowerCase() : null,
      content: Buffer.isBuffer(a.content) ? a.content : Buffer.alloc(0),
      cid: a.cid || null,
      inline: _isShown(a.cid, shown),
    })),
    text: _str(m.text),
    html,
  };
}

// mailparser's address objects: a header may come more than once, and a group
// ("Team: a@x, b@x;") holds its members a level down.
function _addresses(field) {
  const out = [];
  const walk = list => {
    for (const v of list || []) {
      if (v && Array.isArray(v.group)) walk(v.group);
      else if (v && _isAddress(v.address)) out.push({ address: v.address.trim(), name: _str(v.name) });
    }
  };
  for (const obj of [].concat(field || [])) walk(obj && obj.value);
  return out;
}

function _readMsg(buffer) {
  let reader, d;
  try {
    const MsgReader = require('@kenjiuno/msgreader').default;
    // An ArrayBuffer of exactly these bytes: a small Buffer is a view into a
    // pool it shares, and the reader would read the pool from its start.
    reader = new MsgReader(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length));
    d = reader.getFileData();
  } catch {
    return null;
  }
  if (!d || d.dataType !== 'msg') return null;
  const html = _str(d.bodyHtml) || (d.html ? _decode(d.html, d.internetCodepage) : null);
  // An address inside Exchange is a directory path ("/O=EXCHANGELABS/..."),
  // so the SMTP forms are asked first and the transport headers last.
  const from = [d.senderSmtpAddress, d.sentRepresentingSmtpAddress, d.senderEmail, _headerAddress(d.headers, 'from')].find(_isAddress) || null;
  const to = (d.recipients || []).filter(r => r.recipType !== 'bcc').map(r => [r.smtpAddress, r.email].find(_isAddress)).filter(Boolean);
  const shown = _cidsShown(html);
  const attachments = (d.attachments || []).map(a => _msgAttachment(reader, a, shown));
  const text = _str(d.body);
  // A Word or Excel file from before 2007 is the same container with none of
  // a message's parts.
  if (!_str(d.subject) && !from && !text && !html && !attachments.length) return null;
  return {
    subject: _str(d.subject),
    from: from ? from.trim() : null,
    fromName: _str(d.senderName),
    to: to.map(a => a.trim()),
    date: _date(d.clientSubmitTime || d.messageDeliveryTime || d.creationTime),
    attachments,
    text,
    html,
  };
}

function _msgAttachment(reader, a, shown) {
  let content = Buffer.alloc(0);
  let filename = a.fileName || a.fileNameShort || null;
  try {
    // A message attached inside the message comes back as an .msg of its own.
    const got = reader.getAttachment(a);
    content = Buffer.from(got.content || []);
    filename = got.fileName || filename;
  } catch { /* left empty, and skipped as unreadable */ }
  return {
    filename,
    contentType: a.innerMsgContent ? 'application/vnd.ms-outlook' : (a.attachMimeTag ? String(a.attachMimeTag).toLowerCase() : null),
    content,
    cid: a.pidContentId || null,
    inline: _isShown(a.pidContentId, shown),
  };
}

// Outlook keeps the HTML body as bytes in the message's code page.
const CODEPAGES = { 65001: 'utf-8', 1252: 'windows-1252', 28591: 'iso-8859-1', 20127: 'us-ascii', 1250: 'windows-1250', 1251: 'windows-1251',
                    932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 874: 'windows-874' };
function _decode(bytes, codepage) {
  try { return new TextDecoder(CODEPAGES[codepage] || 'utf-8').decode(bytes); }
  catch { return Buffer.from(bytes).toString('utf8'); }
}

function _headerAddress(headers, name) {
  const line = new RegExp(`^${name}:[^\\r\\n]*`, 'im').exec(String(headers || ''));
  const m = line && /[^\s<>"',;:]+@[^\s<>"',;]+/.exec(line[0].slice(name.length + 1));
  return m ? m[0] : null;
}

// The cids the HTML shows (src="cid:..."), read once for every attachment.
function _cidsShown(html) {
  const out = new Set();
  if (html) for (const m of html.matchAll(/cid:([^\s"'<>)]+)/gi)) out.add(m[1].toLowerCase());
  return out;
}
const _isShown = (cid, shown) => !!cid && shown.has(String(cid).replace(/^<|>$/g, '').toLowerCase());

const _str = v => (typeof v === 'string' && v.trim() ? v : null);
const _isAddress = v => typeof v === 'string' && /^[^\s@]+@[^\s@]+$/.test(v.trim());
function _date(v) {
  const d = v instanceof Date ? v : (v ? new Date(v) : null);
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

// ── The receipts in a mail ──────────────────────────────────────────────────
// A picture under this many bytes is a logo, an icon or a tracking pixel; no
// photograph or scan of a receipt is that small. A PDF is never held to it: a
// typed invoice can be a few kilobytes.
const TINY_BYTES = 12 * 1024;
// A picture the message shows by its cid is part of its design, a logo or a
// signature, unless it is the size of a photograph or a screenshot: that is
// how a phone's mail app sends a photo taken for the purpose, and how Outlook
// sends a screenshot pasted into the message. A banner is wide and short, a
// logo small; a receipt photographed or captured is neither.
const PHOTO_SHORT_SIDE = 400;
const PHOTO_LONG_SIDE = 600;
// As many receipts as a zip of them may bring (claims/claim-archive.js): each
// one is a read, and a mail of thousands is a mistake, not a claim.
const MAX_FILES = 100;
// A mail forwarded as an attachment is opened, so its receipts are found; a
// mail inside that one is not.
const MAX_DEPTH = 1;

const RECEIPT_KINDS = new Set([...KEEP, ...CONVERT]);
const MESSAGE_TYPES = new Set(['message/rfc822', 'application/vnd.ms-outlook']);
const LOOKS_LIKE_RECEIPT = /\.(pdf|jpe?g|png|heic|heif|webp|tiff?|gif|avif)$/i;

// Returns { files: [{ buffer, filename, declaredMime }], skipped: [{ name, why }],
// bodyPdf }. `bodyPdf` is the message as a PDF when nothing in it was a
// receipt file, else null. `timeZone` is the one the message's date is printed in.
async function receiptsFromMail(mail, { timeZone = 'UTC', depth = 0 } = {}) {
  const files = [], skipped = [];
  for (const a of mail.attachments || []) {
    const name = a.filename || 'an unnamed attachment';
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.alloc(0);
    if (!content.length) { skipped.push({ name, why: 'could not be read' }); continue; }
    const kind = sniff(content);
    if (RECEIPT_KINDS.has(kind)) {
      if (kind !== 'application/pdf') {
        if (content.length < TINY_BYTES) { skipped.push({ name, why: 'too small to be a receipt (a logo, an icon or a tracking image)' }); continue; }
        if (a.inline && !(await _photoSized(content, kind))) { skipped.push({ name, why: 'a picture in the message itself, such as a logo or a signature' }); continue; }
      }
      files.push({ buffer: content, filename: a.filename || null, declaredMime: a.contentType || kind });
      continue;
    }
    // A mail forwarded as an attachment: what is in it counts as if it had
    // been sent itself, its own text included when it has nothing attached.
    // An Outlook message is known by its container, which an old Word or
    // Excel file shares, so only one that opens as a mail is taken for one.
    const saysMail = MESSAGE_TYPES.has(a.contentType) || /\.(eml|msg)$/i.test(a.filename || '');
    if (saysMail || isMsg(content)) {
      if (depth >= MAX_DEPTH) {
        if (saysMail) { skipped.push({ name, why: 'an email inside an attached email' }); continue; }
      } else {
        const inner = await parseMail(content).catch(() => null);
        if (inner) {
          const got = await receiptsFromMail(inner, { timeZone, depth: depth + 1 });
          files.push(...got.files);
          skipped.push(...got.skipped);
          if (got.bodyPdf) files.push({ buffer: got.bodyPdf, filename: pdfName(inner.subject), declaredMime: 'application/pdf' });
          continue;
        }
        if (saysMail) { skipped.push({ name, why: 'an attached email that could not be opened' }); continue; }
      }
    }
    const claimed = LOOKS_LIKE_RECEIPT.test(a.filename || '') || /^(image\/|application\/pdf)/.test(a.contentType || '');
    skipped.push({ name, why: claimed ? 'not a real image or PDF' : 'not a receipt file type' });
  }
  for (const f of files.splice(MAX_FILES)) skipped.push({ name: f.filename || 'an unnamed attachment', why: `more than ${MAX_FILES} receipts in one email` });

  let bodyPdf = null;
  if (!files.length) {
    bodyPdf = await messagePdf(mail, { timeZone });
    if (!bodyPdf) skipped.push({ name: mail.subject || 'the message', why: 'no receipt is attached, and the message has no text to keep' });
  }
  return { files, skipped, bodyPdf };
}

async function _photoSized(buffer, kind) {
  // Only a camera makes a HEIC, and sharp may not open one to measure it.
  if (kind === 'image/heic' || kind === 'image/heif') return true;
  const sharp = loadSharp();
  if (!sharp) return false;
  try {
    const { width, height } = await sharp(buffer, { limitInputPixels: 150 * 1000 * 1000 }).metadata();
    return Math.min(width, height) >= PHOTO_SHORT_SIDE && Math.max(width, height) >= PHOTO_LONG_SIDE;
  } catch {
    return false;
  }
}

// ── The message as a PDF ────────────────────────────────────────────────────
// From, date and subject, then the text the person would read. The plain-text
// body when the mail has one, else its HTML reduced to text. The reader takes
// a PDF with a text layer as typed, so this reads like any e-receipt PDF.
//
// The same mail always makes the same bytes (the PDF's dates are the mail's
// own), so the same e-receipt sent twice is caught as a duplicate.
const MAX_BODY_CHARS = 20000;
async function messagePdf(mail, { timeZone = 'UTC' } = {}) {
  let body = _tidy(mail.text) || htmlToText(mail.html);
  if (!body) return null;
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n\n[The rest of the message was left out.]`;
  const head = [
    ['From', mail.fromName && mail.from ? `${mail.fromName} <${mail.from}>` : mail.from],
    ['Date', _when(mail.date, timeZone)],
    ['Subject', mail.subject],
  ].filter(([, v]) => v);
  const stamp = mail.date || new Date(0);
  const doc = {
    info: { title: winAnsi(mail.subject || 'Email'), creator: 'Solv', producer: 'Solv', creationDate: stamp, modDate: stamp },
    pageSize: 'A4',
    pageMargins: [48, 48, 48, 48],
    defaultStyle: { font: 'Helvetica', fontSize: 10, lineHeight: 1.2 },
    content: [
      ...head.map(([k, v]) => ({ text: [{ text: `${k}: `, bold: true }, winAnsi(v)] })),
      { text: winAnsi(body), margin: [0, 14, 0, 0] },
    ],
  };
  return require('../reports/expense-export').pdfBuffer(doc);
}

function _when(date, timeZone) {
  if (!date) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                                              hour12: false, timeZone, timeZoneName: 'short' }).format(date);
  } catch {
    return date.toUTCString();
  }
}

// The file name the message's PDF is stored under: its subject, without the
// "Fwd:" a forward adds and without what a file name cannot hold.
function pdfName(subject) {
  const clean = String(subject || '')
    .replace(/^(\s*(re|fw|fwd|aw|wg|tr)\s*:\s*)+/i, '')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .trim();
  return `${clean || 'Email'}.pdf`;
}

// HTML to the text a person sees: no head, styles or scripts, a line for each
// block and row, a space between table cells, entities decoded. Enough for a
// receipt, which is all it is for.
//
// Whoever sent the mail wrote this HTML, so every pass is linear in its
// length: a tag is matched without crossing another "<", and the blocks that
// are dropped whole are cut by searching forward, never by a pattern that
// could rescan the rest of the message from every unclosed "<style".
const MAX_HTML_CHARS = 2 * 1024 * 1024;
function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  const s = _dropHidden(html.slice(0, MAX_HTML_CHARS))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^<>]*>/gi, '\n• ')
    .replace(/<\/?(p|div|tr|table|tbody|thead|h[1-6]|ul|ol|blockquote|pre|address|section|article|header|footer|center|hr)\b[^<>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^<>]*>/g, '');
  return _tidy(_entities(s));
}

// Comments and the blocks nobody sees, each cut from its opening to its end;
// one left open takes the rest of the HTML with it.
const HIDDEN = /<!--|<(head|style|script|title|template|noscript)\b/gi;
function _dropHidden(html) {
  const lower = html.toLowerCase();
  let out = '', from = 0, m;
  HIDDEN.lastIndex = 0;
  while ((m = HIDDEN.exec(html))) {
    out += html.slice(from, m.index);
    const closer = m[1] ? `</${m[1].toLowerCase()}` : '-->';
    const at = lower.indexOf(closer, HIDDEN.lastIndex);
    if (at === -1) return out;
    const end = m[1] ? lower.indexOf('>', at) : at + 2;
    if (end === -1) return out;
    from = end + 1;
    HIDDEN.lastIndex = from;
  }
  return out + html.slice(from);
}

const ENTITIES = new Map(Object.entries({
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", euro: '€', pound: '£', yen: '¥', cent: '¢', copy: '©', reg: '®', trade: '™',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', times: '×', deg: '°',
  zwnj: '', zwj: '', shy: '', thinsp: ' ', ensp: ' ', emsp: ' ',
}));
function _entities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (whole, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    const v = ENTITIES.get(e.toLowerCase());
    return v === undefined ? whole : v;
  });
}

function _tidy(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‍⁠﻿͏­]/g, '')
    .replace(/[  -   　\t]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The standard PDF fonts draw the Windows Latin-1 set and nothing else; a
// character outside it comes out as another one, so "₹500" would be read as
// "¹500". A currency sign the reader needs becomes its code, and anything
// else outside the set a "?" (reports/expense-doc.js does the same).
const CURRENCY_SIGNS = new Map(Object.entries({
  '₹': 'INR ', '₩': 'KRW ', '₱': 'PHP ', '฿': 'THB ', '₫': 'VND ', '₪': 'ILS ', '₺': 'TRY ', '₽': 'RUB ', '₦': 'NGN ', '₴': 'UAH ',
  '₸': 'KZT ', '₭': 'LAK ', '₮': 'MNT ', '៛': 'KHR ', '₨': 'Rs ', '元': ' CNY ', '円': ' JPY ',
}));
const WIN_ANSI = /[^\n\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g;
function winAnsi(text) {
  return String(text ?? '')
    .replace(/[₹₩₱฿₫₪₺₽₦₴₸₭₮៛₨元円]/g, c => CURRENCY_SIGNS.get(c))
    .replace(/[­]/g, '')
    .replace(WIN_ANSI, '?');
}

module.exports = {
  parseMail, receiptsFromMail, messagePdf, pdfName, htmlToText, winAnsi, isMsg,
  NOT_A_MAIL, TINY_BYTES, MAX_FILES, PHOTO_SHORT_SIDE, PHOTO_LONG_SIDE,
};
