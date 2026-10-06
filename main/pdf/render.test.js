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
