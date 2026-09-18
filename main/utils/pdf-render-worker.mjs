// Renders every page of a PDF to a JPEG file. Runs as a child process of
// pdf-render.js: pdfjs is ESM-only and heavy, and a render that blows up must
// not take the server with it.
//
// Usage: node pdf-render-worker.mjs <input.pdf> <outDir> <dpi> <maxPages>
// Prints one JSON line: { numPages, rendered: [{ page, file, width, height }] }
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const [,, input, outDir, dpiArg = '150', maxArg = '20'] = process.argv;
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const data = new Uint8Array(fs.readFileSync(input));
const doc  = await getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
const scale = Number(dpiArg) / 72;
const n = Math.min(doc.numPages, Number(maxArg));
fs.mkdirSync(outDir, { recursive: true });

const rendered = [];
for (let i = 1; i <= n; i++) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale });
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
