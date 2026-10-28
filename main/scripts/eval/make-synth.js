// Draws the synthetic receipts in receipts.js as photographs: a slight tilt
// on a grey desk, a touch of blur, JPEG. The same lines, angle and fonts give
// the same image every time, so two runs of the reader see the same pixels
// and a change in the score is a change in the reader.
//
// The fonts are the machine's own (a monospace like a till printer's, and a
// Japanese one for the ramen receipt); which were used is written beside the
// images, because another machine's fonts draw other pixels.
const fs = require('fs');
const path = require('path');
const { SYNTH } = require('./receipts');

const FONTS = {
  mono: ['C:/Windows/Fonts/consola.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/System/Library/Fonts/Menlo.ttc'],
  bold: ['C:/Windows/Fonts/consolab.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', '/System/Library/Fonts/Menlo.ttc'],
  cjk:  ['C:/Windows/Fonts/msgothic.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc'],
};

function _register(GlobalFonts) {
  const used = {};
  for (const [family, candidates] of Object.entries(FONTS)) {
    const file = candidates.find(f => fs.existsSync(f));
    // Without the file the canvas falls back to its own font; still drawn,
    // still the same each time on this machine.
    if (file && GlobalFonts.registerFromPath(file, `eval-${family}`)) used[family] = file;
    else used[family] = null;
  }
  return used;
}

const W = 640, PAD = 28, LH = 30;
function _draw(createCanvas, lines, { font, bold, size = 21 }) {
  const H = PAD * 2 + lines.length * LH + 20;
  const cv = createCanvas(W, H);
  const g = cv.getContext('2d');
  g.fillStyle = '#fbfaf6'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#1a1a1a'; g.textBaseline = 'top';
  let y = PAD;
  for (const ln of lines) {
    g.font = `${size}px ${font}`;
    g.textAlign = 'left';
    if (ln === '-') g.fillText('-'.repeat(48).slice(0, Math.floor((W - 2 * PAD) / (size * 0.55))), PAD, y);
    else if (typeof ln === 'string') g.fillText(ln, PAD, y);
    else if (Array.isArray(ln)) { g.fillText(ln[0], PAD, y); g.textAlign = 'right'; g.fillText(ln[1], W - PAD, y); }
    else if (ln.b) { g.font = `${size + 5}px ${bold}`; g.textAlign = 'center'; g.fillText(ln.b, W / 2, y); }
    else if (ln.c) { g.textAlign = 'center'; g.fillText(ln.c, W / 2, y); }
    y += LH;
  }
  return cv.toBuffer('image/png');
}

// Writes <outDir>/synth/<name>.jpg for each receipt (or those named) and
// returns their paths.
async function makeSynth(outDir, { only = null } = {}) {
  const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
  const sharp = require('sharp');
  const dir = path.join(outDir, 'synth');
  fs.mkdirSync(dir, { recursive: true });
  const used = _register(GlobalFonts);
  const fam = f => (used[f] ? `eval-${f}` : 'monospace');
  const made = {};
  for (const [name, spec] of Object.entries(SYNTH)) {
    if (only && !only.includes(name)) continue;
    const cjk = spec.font === 'cjk';
    const png = _draw(createCanvas, spec.draw, { font: cjk ? fam('cjk') : fam('mono'), bold: cjk ? fam('cjk') : fam('bold') });
    const jpg = await sharp(png).rotate(spec.angle || 0, { background: '#8a8a86' }).blur(0.6).jpeg({ quality: 82 }).toBuffer();
    const file = path.join(dir, `${name}.jpg`);
    fs.writeFileSync(file, jpg);
    made[name] = file;
  }
  fs.writeFileSync(path.join(dir, 'fonts.json'), JSON.stringify(used, null, 2));
  return made;
}

module.exports = { makeSynth };

if (require.main === module) {
  const out = process.argv[2] || path.join(require('os').tmpdir(), 'solv-eval');
  makeSynth(out).then(made => { for (const f of Object.values(made)) console.log(f); })
    .catch(err => { console.error(err); process.exit(1); });
}
