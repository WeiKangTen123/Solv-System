// Real emails for tests, built by hand: an .eml in MIME as a mail program
// writes it, and an Outlook .msg burned into the compound-file container
// Outlook saves (with @kenjiuno/msgreader's own writer). Nothing real belongs
// in a public repository, and each test says exactly what is in its mail.

// ── .eml ─────────────────────────────────────────────────────────────────────
let _boundary = 0;
const b64 = buf => buf.toString('base64').replace(/.{76}/g, '$&\r\n');

function _part(headers, body) {
  return [...headers, '', body].join('\r\n');
}
function _multipart(type, parts) {
  const boundary = `=_solv_test_${++_boundary}`;
  return {
    headers: [`Content-Type: multipart/${type}; boundary="${boundary}"`],
    body: [...parts.map(p => `--${boundary}\r\n${_part(p.headers, p.body)}`), `--${boundary}--`, ''].join('\r\n'),
  };
}
function _file(a) {
  const disposition = a.inline ? 'inline' : 'attachment';
  if (a.message) {
    return { headers: ['Content-Type: message/rfc822', `Content-Disposition: ${disposition}${a.filename ? `; filename="${a.filename}"` : ''}`], body: a.content.toString('utf8') };
  }
  return {
    headers: [
      `Content-Type: ${a.contentType || 'application/octet-stream'}${a.filename ? `; name="${a.filename}"` : ''}`,
      `Content-Disposition: ${disposition}${a.filename ? `; filename="${a.filename}"` : ''}`,
      ...(a.cid ? [`Content-ID: <${a.cid}>`] : []),
      'Content-Transfer-Encoding: base64',
    ],
    body: b64(a.content),
  };
}

// { from, to, cc, subject, date, text, html, attachments: [{ filename,
// contentType, content, cid, inline, message }], headers: ['X-Foo: bar'] }.
// An attachment with a cid is put beside the HTML in multipart/related, as a
// mail program does with a picture the message shows.
function eml({ from = 'Jane Tan <jane@solv.sg>', to = 'receipts@in.solv.sg', cc = null, subject = 'Receipt', date = 'Wed, 21 Oct 2026 09:12:00 +0800',
               text = null, html = null, attachments = [], headers = [] } = {}) {
  const inline = attachments.filter(a => a.cid);
  const files = attachments.filter(a => !a.cid);
  const textPart = text !== null ? { headers: ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit'], body: text } : null;
  let htmlPart = html !== null ? { headers: ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit'], body: html } : null;
  if (htmlPart && inline.length) htmlPart = _multipart('related', [htmlPart, ...inline.map(_file)]);
  let body = textPart && htmlPart ? _multipart('alternative', [textPart, htmlPart]) : (htmlPart || textPart || { headers: ['Content-Type: text/plain; charset=utf-8'], body: '' });
  if (files.length) body = _multipart('mixed', [body, ...files.map(_file)]);
  const head = [
    `From: ${from}`, `To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), `Subject: ${subject}`, `Date: ${date}`,
    `Message-ID: <${Date.now()}.${_boundary}@test.solv>`, 'MIME-Version: 1.0', ...headers, ...body.headers,
  ];
  return Buffer.from(_part(head, body.body), 'utf8');
}

// ── .msg ─────────────────────────────────────────────────────────────────────
// MS-OXMSG: a string property is a stream named __substg1.0_<tag><type>, with
// 001F for UTF-16; fixed-size ones live in __properties_version1.0. The
// burner reads each stream through its provider, and a small Buffer is a view
// into a shared pool, so every stream is copied into its own array first.
const { burn } = require('@kenjiuno/msgreader/lib/Burner');
const DIRECTORY = 1, DOCUMENT = 2, ROOT = 5;
const u16 = s => Buffer.from(`${s}\0`, 'utf16le');
const _doc = (name, raw) => { const data = new Uint8Array(raw); return { name, type: DOCUMENT, binaryProvider: () => data, length: data.length }; };
const _fileTime = d => BigInt(d.getTime()) * 10000n + 116444736000000000n;

// { from, fromName, to: [..], subject, date (Date), text, html, attachments:
// [{ filename, contentType, content, cid }] }
function msg({ from = 'jane@solv.sg', fromName = 'Jane Tan', to = ['receipts@in.solv.sg'], subject = 'Receipt', date = new Date('2026-10-21T01:12:00Z'),
               text = null, html = null, attachments = [] } = {}) {
  const entries = [{ name: 'Root Entry', type: ROOT, children: [], length: 0 }];
  const add = (parent, entry) => { entries[parent].children.push(entries.length); entries.push(entry); return entries.length - 1; };
  add(0, _doc('__substg1.0_001A001F', u16('IPM.Note')));
  add(0, _doc('__substg1.0_0037001F', u16(subject)));
  add(0, _doc('__substg1.0_0C1A001F', u16(fromName)));
  add(0, _doc('__substg1.0_0C1F001F', u16(from)));
  add(0, _doc('__substg1.0_5D01001F', u16(from)));
  if (text !== null) add(0, _doc('__substg1.0_1000001F', u16(text)));
  if (html !== null) add(0, _doc('__substg1.0_10130102', Buffer.from(html, 'utf8')));
  // The root's property stream: a 32-byte header, then 16 bytes a property.
  const props = Buffer.alloc(32 + 16);
  props.writeUInt32LE(0x00390040, 32);          // PidTagClientSubmitTime, a FILETIME
  props.writeUInt32LE(6, 36);
  props.writeBigUInt64LE(_fileTime(date), 40);
  add(0, _doc('__properties_version1.0', props));
  to.forEach((address, i) => {
    const dir = add(0, { name: `__recip_version1.0_#${String(i).padStart(8, '0')}`, type: DIRECTORY, children: [], length: 0 });
    add(dir, _doc('__substg1.0_3003001F', u16(address)));
    add(dir, _doc('__substg1.0_39FE001F', u16(address)));
    const p = Buffer.alloc(8 + 16);
    p.writeUInt32LE(0x0C150003, 8); p.writeUInt32LE(6, 12); p.writeUInt32LE(1, 16);   // PidTagRecipientType: To
    add(dir, _doc('__properties_version1.0', p));
  });
  attachments.forEach((a, i) => {
    const dir = add(0, { name: `__attach_version1.0_#${String(i).padStart(8, '0')}`, type: DIRECTORY, children: [], length: 0 });
    add(dir, _doc('__substg1.0_3707001F', u16(a.filename)));
    if (a.contentType) add(dir, _doc('__substg1.0_370E001F', u16(a.contentType)));
    if (a.cid) add(dir, _doc('__substg1.0_3712001F', u16(a.cid)));
    add(dir, _doc('__substg1.0_37010102', a.content));
  });
  return Buffer.from(burn(entries));
}

// ── what goes in them ────────────────────────────────────────────────────────
// A PDF the reader would take as typed: the signature is what intake/convert.js
// looks for, and `n` keeps two of them from being the same bytes.
const fakePdf = (n = 1) => Buffer.from(`%PDF-1.4\n% receipt ${n}\n`);
// A photograph-sized JPEG, well over the 12 KB a logo is held to.
function photo({ width = 900, height = 1200, seed = 0 } = {}) {
  return require('sharp')({ create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 120 + seed, sigma: 40 } } }).jpeg({ quality: 80 }).toBuffer();
}
// A logo: a small picture of a few hundred bytes.
function logo({ width = 120, height = 40 } = {}) {
  return require('sharp')({ create: { width, height, channels: 3, background: '#1a7' } }).png().toBuffer();
}

module.exports = { eml, msg, fakePdf, photo, logo };
