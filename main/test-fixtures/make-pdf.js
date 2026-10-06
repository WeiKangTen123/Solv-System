// A made-up two-page "scanned" folio for tests: each page is one picture, as
// a scanner makes it, with no text layer. The tests used to load a real hotel
// folio, which carried a real guest's name and address; nothing real belongs
// in a public repository.
const PdfPrinter = require('pdfmake');
const sharp = require('sharp');

const FONTS = { Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } };

async function pageImage(seed) {
  // Grey noise is enough to make a page that renders to a real picture.
  return sharp({ create: { width: 1240, height: 1600, channels: 3, noise: { type: 'gaussian', mean: 200 + seed, sigma: 30 } } }).jpeg({ quality: 70 }).toBuffer();
}

async function scannedPdf(pages = 2) {
  const images = [];
  for (let i = 0; i < pages; i++) images.push(await pageImage(i));
  const printer = new PdfPrinter(FONTS);
  const doc = printer.createPdfKitDocument({
    pageSize: 'A4', pageMargins: [0, 0, 0, 0], defaultStyle: { font: 'Helvetica' },
    content: images.map((img, i) => ({ image: `data:image/jpeg;base64,${img.toString('base64')}`, width: 595, ...(i < images.length - 1 ? { pageBreak: 'after' } : {}) })),
  });
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

module.exports = { scannedPdf };
