// Renders every page of a PDF to a JPEG file. Runs as a child process of
// pdf-render.js: pdfjs is ESM-only and heavy, and a render that blows up must
// not take the server with it.
//
// Usage: node render-worker.mjs <input.pdf> <outDir> <dpi> <maxPages> [pages]
// `pages` is a comma list of page numbers to draw; without it, the first maxPages.
// Prints one JSON line: { numPages, rendered: [{ page, file, width, height }] }
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const [,, input, outDir, dpiArg = '150', maxArg = '20', onlyArg = ''] = process.argv;
const only = onlyArg ? new Set(onlyArg.split(',').map(Number).filter(n => Number.isInteger(n) && n > 0)) : null;
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

// A page is as big as the file says, up to 200 inches a side. At 150 dpi a
// 418-byte PDF with one such page asked for a 30000 × 30000 canvas, about
// 3.4 GiB, from a stranger's upload. A page that would pass 25 megapixels is
// drawn smaller to fit; an A4 page at 150 dpi is 2.2, and keeps its 150 dpi.
const MAX_PIXELS = 25_000_000;
function scaleFor(page, wanted) {
  const one = page.getViewport({ scale: 1 });
  let scale = Math.min(wanted, Math.sqrt(MAX_PIXELS / Math.max(1, one.width * one.height)));
  // The canvas is rounded up to whole pixels, which can tip a fitted page just over.
  while (Math.ceil(one.width * scale) * Math.ceil(one.height * scale) > MAX_PIXELS) scale *= 0.999;
  return scale;
}

const data = new Uint8Array(fs.readFileSync(input));
const doc  = await getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
const scale = Number(dpiArg) / 72;
const n = Math.min(doc.numPages, Number(maxArg));
fs.mkdirSync(outDir, { recursive: true });

const rendered = [];
const wanted = only ? [...only].filter(p => p <= doc.numPages).sort((a, b) => a - b).slice(0, n) : Array.from({ length: n }, (_, k) => k + 1);
for (const i of wanted) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale: scaleFor(page, scale) });
  const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const file = path.join(outDir, `page-${i}.jpg`);
  fs.writeFileSync(file, canvas.toBuffer('image/jpeg', 85));
  rendered.push({ page: i, file, width, height });
  page.cleanup();
}
const numPages = doc.numPages;
// Older and newer builds name the teardown differently; neither is required for a one-shot process.
if (typeof doc.destroy === 'function') await doc.destroy(); else if (typeof doc.cleanup === 'function') await doc.cleanup();
process.stdout.write(JSON.stringify({ numPages, rendered }));
