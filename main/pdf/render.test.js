const PdfPrinter = require('pdfmake');

// A real two-page PDF, built here so the test never depends on a fixture file.
async function twoPagePdf() {
  const fonts = { Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } };
  const doc = new PdfPrinter(fonts).createPdfKitDocument({
    defaultStyle: { font: 'Helvetica' },
    content: [{ text: 'TAX INVOICE page one', fontSize: 20 }, { text: 'second page', pageBreak: 'before', fontSize: 20 }],
  });
  const chunks = [];
  return new Promise(resolve => { doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.end(); });
}

describe('pdf/render', () => {
  const { renderPdfPages } = require('./render');

  test('renders every page to a JPEG of A4 proportions at 150 dpi', async () => {
    const out = await renderPdfPages(await twoPagePdf());
    expect(out).not.toBeNull();
    expect(out.numPages).toBe(2);
    expect(out.pages).toHaveLength(2);
    for (const p of out.pages) {
      expect(p.buffer[0]).toBe(0xff); expect(p.buffer[1]).toBe(0xd8);   // JPEG magic
      expect(p.width).toBeGreaterThan(1100); expect(p.width).toBeLessThan(1300);
      expect(p.height).toBeGreaterThan(p.width);
    }
  }, 60000);

  test('maxPages caps the work', async () => {
    const out = await renderPdfPages(await twoPagePdf(), { maxPages: 1 });
    expect(out.numPages).toBe(2);
    expect(out.pages).toHaveLength(1);
  }, 60000);

  test('garbage bytes return null rather than throwing', async () => {
    expect(await renderPdfPages(Buffer.from('not a pdf'))).toBeNull();
    expect(await renderPdfPages(Buffer.alloc(0))).toBeNull();
  }, 60000);

  test('a page far larger than paper is drawn no bigger than 25 megapixels', async () => {
    // A few hundred bytes asking for a 200-inch page. At 150 dpi that was a
    // 30000 x 30000 canvas, about 3.4 GiB, in a process the server waits on.
    const huge = Buffer.from([
      '%PDF-1.4',
      '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
      '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj',
      '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 14400 14400]>> endobj',
      'trailer <</Root 1 0 R>>',
      '%%EOF',
    ].join('\n'));
    const out = await renderPdfPages(huge);
    expect(out.pages).toHaveLength(1);
    const { width, height, buffer } = out.pages[0];
    expect(width * height).toBeLessThanOrEqual(25_000_000);
    expect(width).toBeGreaterThan(4900);          // fitted to the cap, not refused
    const meta = await require('sharp')(buffer).metadata();
    expect(meta.width * meta.height).toBeLessThanOrEqual(25_000_000);
  }, 60000);

  test('a scanned two-page folio renders both pages, or only the page asked for', async () => {
    const pdf = await require('../test-fixtures/make-pdf').scannedPdf(2);
    const out = await renderPdfPages(pdf);
    expect(out.numPages).toBe(2);
    expect(out.pages.map(p => p.page)).toEqual([1, 2]);
    expect(out.pages[0].buffer.length).toBeGreaterThan(20000);
    const one = await renderPdfPages(pdf, { pages: [2] });
    expect(one.pages.map(p => p.page)).toEqual([2]);
  }, 90000);
});
