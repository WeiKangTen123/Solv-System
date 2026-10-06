// Reads the text layer of every page of a PDF. Runs as a child process of
// text-extract.js, like render-worker.mjs beside it: a PDF is whatever a
// stranger uploaded, and a crafted one that hangs or crashes the parser must
// take this process with it, not the server.
//
// Usage: node text-worker.mjs <input.pdf> <maxPages>
// Prints one JSON line: { numPages, pages: [text, ...] }
import fs from 'node:fs';

const [,, input, maxArg = '50'] = process.argv;
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const data = new Uint8Array(fs.readFileSync(input));
// isEvalSupported: false keeps the parser from compiling font programs into
// JavaScript, the path behind PDF.js's worst published flaw (CVE-2024-4367).
const doc = await getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
const n = Math.min(doc.numPages, Number(maxArg) || 50);

const pages = [];
for (let i = 1; i <= n; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  pages.push(content.items.map(it => it.str || '').join(' ').replace(/\s+/g, ' ').trim());
  page.cleanup();
}
const numPages = doc.numPages;
if (typeof doc.destroy === 'function') await doc.destroy();
process.stdout.write(JSON.stringify({ numPages, pages }));
