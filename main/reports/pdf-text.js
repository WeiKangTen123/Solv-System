const path = require('path');

// The fonts the case PDF embeds, and which of them draws a given character.
//
// The PDF used to print in Helvetica, which every reader has built in and which
// covers Latin-1 only: a merchant named in Chinese printed as "???". Noto Sans
// draws Latin, Greek, Cyrillic and Vietnamese; a cut-down Noto Sans SC draws
// Chinese and Japanese kana (main/assets/fonts/README.md). pdfmake does not
// fall back from one font to another by itself, so text that people or the
// reader wrote goes through runs(): each stretch goes to the font that has it,
// and a character neither has (Thai, Tamil, an emoji) prints as "?" rather
// than as an empty box nobody can read.
const DIR = path.join(__dirname, '../assets/fonts');
const file = name => path.join(DIR, name);

const FONTS = {
  NotoSans:   { normal: file('NotoSans-Regular.ttf'), bold: file('NotoSans-Bold.ttf'), italics: file('NotoSans-Regular.ttf'), bolditalics: file('NotoSans-Bold.ttf') },
  NotoSansSC: { normal: file('NotoSansSC-Regular.otf'), bold: file('NotoSansSC-Bold.otf'), italics: file('NotoSansSC-Regular.otf'), bolditalics: file('NotoSansSC-Bold.otf') },
};
const BODY_FONT = 'NotoSans';
const CJK_FONT = 'NotoSansSC';

// [from, to] code point ranges, read from the fonts by coverage.py.
let _cover = null;
function cover() {
  if (!_cover) _cover = require('../assets/fonts/coverage.json');
  return _cover;
}
function inRanges(ranges, cp) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (cp < a) hi = mid - 1; else if (cp > b) lo = mid + 1; else return true;
  }
  return false;
}

// 'L' for the body font, 'C' for the Chinese one, null for neither. A line
// break and a tab are the body font's: pdfmake lays them out itself.
function fontFor(cp) {
  if (cp === 10 || cp === 9) return 'L';
  if (inRanges(cover()[BODY_FONT], cp)) return 'L';
  if (inRanges(cover()[CJK_FONT], cp)) return 'C';
  return null;
}

// Text for pdfmake: a plain string when the body font draws all of it, or an
// array of runs, the Chinese ones naming their font.
function runs(value) {
  const s = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  const out = [];
  let cur = null, buf = '';
  for (const ch of s) {
    const which = fontFor(ch.codePointAt(0));
    const kind = which || 'L';
    const text = which ? ch : '?';
    if (kind !== cur && buf) { out.push(cur === 'C' ? { text: buf, font: CJK_FONT } : buf); buf = ''; }
    cur = kind; buf += text;
  }
  if (buf) out.push(cur === 'C' ? { text: buf, font: CJK_FONT } : buf);
  if (out.length <= 1 && typeof out[0] !== 'object') return out[0] || '';
  return out;
}

// The same text as one string, with what neither font draws folded to "?".
// For the places pdfmake wants a plain string (the document's metadata).
function plain(value) {
  let out = '';
  for (const ch of String(value ?? '')) out += fontFor(ch.codePointAt(0)) ? ch : '?';
  return out;
}

module.exports = { FONTS, BODY_FONT, CJK_FONT, runs, plain, _fontFor: fontFor };
