jest.mock('./text-extract');
const textExtract = require('./text-extract');
const { extractPages, splittablePages } = require('./pages');

// The child-process extractor, answering with the given page texts.
const pdfParse = textExtract.extractText;
function fakePdf(pageTexts) {
  return async () => ({ numPages: pageTexts.length, pages: pageTexts });
}

const LONG = 'Receipt total 18.40 SGD merchant Grab date 2026-08-24 thank you for riding';

beforeEach(() => jest.clearAllMocks());

describe('pdf/pages', () => {
  describe('extractPages', () => {
    test('returns one entry per page, in order', async () => {
      pdfParse.mockImplementation(fakePdf([`${LONG} one`, `${LONG} two`, `${LONG} three`]));
      const r = await extractPages(Buffer.from('%PDF'));
      expect(r.pages).toHaveLength(3);
      expect(r.pages[0]).toMatch(/one$/);
      expect(r.pages[2]).toMatch(/three$/);
      expect(r.hasText).toBe(true);
    });

    test('a scan has no text layer and says so rather than guessing', async () => {
      // Every page is images, so there is nothing to read. Rendering those pages
      // would need a real PDF renderer, which is a deliberate non-goal.
      pdfParse.mockImplementation(fakePdf(['', '', '']));
      const r = await extractPages(Buffer.from('%PDF'));
      expect(r.hasText).toBe(false);
      expect(r.textPageCount).toBe(0);
    });

    test('an empty or non-buffer input is handled, not thrown on', async () => {
      expect((await extractPages(Buffer.alloc(0))).numPages).toBe(0);
      expect((await extractPages(null)).numPages).toBe(0);
      expect(pdfParse).not.toHaveBeenCalled();
    });

    test('a corrupt PDF degrades to no pages instead of throwing', async () => {
      pdfParse.mockRejectedValue(new Error('bad xref'));
      const r = await extractPages(Buffer.from('not a pdf'));
      expect(r.pages).toEqual([]);
      expect(r.hasText).toBe(false);
      // and says it failed, which is not the same as a scan with no text:
      // a scan is drawn next, a file that could not be opened is not.
      expect(r.failed).toBe(true);
    });

    test('a scan is not a failure', async () => {
      pdfParse.mockImplementation(fakePdf(['', '']));
      expect((await extractPages(Buffer.from('%PDF'))).failed).toBeUndefined();
    });
  });

  describe('splittablePages', () => {
    test('a multi-page PDF with text on each page splits', () => {
      const r = splittablePages({ pages: [LONG, LONG, LONG], hasText: true });
      expect(r.split).toBe(true);
      expect(r.pageNumbers).toEqual([1, 2, 3]);
    });

    test('a single-page PDF is an ordinary receipt, not a split', () => {
      expect(splittablePages({ pages: [LONG], hasText: true }).split).toBe(false);
    });

    test('a scan does not split, and the reason says why', () => {
      const r = splittablePages({ pages: ['', ''], hasText: false });
      expect(r.split).toBe(false);
      expect(r.reason).toMatch(/scan/i);
    });

    test('near-empty pages are excluded so no blank records are created', () => {
      const r = splittablePages({ pages: [LONG, 'x', LONG], hasText: true });
      expect(r.pageNumbers).toEqual([1, 3]);   // page 2 skipped
      expect(r.split).toBe(true);
    });

    test('if only one page has readable text there is nothing to split', () => {
      const r = splittablePages({ pages: [LONG, 'x', ''], hasText: true });
      expect(r.split).toBe(false);
    });

    test('page numbers are 1-based, matching what a PDF viewer shows', () => {
      const r = splittablePages({ pages: [LONG, LONG], hasText: true });
      expect(r.pageNumbers[0]).toBe(1);
    });

    test('one threshold decides whether a page has text, wherever it is asked', () => {
      const { pageHasText, MIN_PAGE_CHARS } = require('./pages');
      expect(pageHasText(LONG)).toBe(true);
      expect(pageHasText('x'.repeat(MIN_PAGE_CHARS - 1))).toBe(false);
      expect(pageHasText(`   ${'x'.repeat(MIN_PAGE_CHARS - 1)}   `)).toBe(false);
      expect(pageHasText(null)).toBe(false);
      expect(pageHasText(undefined)).toBe(false);
    });

    test('nothing at all is handled', () => {
      expect(splittablePages().split).toBe(false);
      expect(splittablePages({}).split).toBe(false);
    });
  });
});

describe('pdf-pages — sameDocument', () => {
  const { sameDocument, splittablePages } = require('./pages');
  const folio = n => `COURTYARD BY MARRIOTT PUNE CHAKAN TAX INVOICE Invoice # : 00/000-000001 Page ${n} of 4 charges ...`;

  test('pages sharing an invoice number are one document', () => {
    expect(sameDocument([folio(1), folio(2), folio(3)])).toBe(true);
    expect(splittablePages({ pages: [folio(1), folio(2)], hasText: true })).toMatchObject({ split: false, reason: 'pages of one document' });
  });

  test('pages with different numbers are separate receipts', () => {
    expect(sameDocument(['GRAB Receipt No: A1 total 18.40 for the ride home tonight', 'GRAB Receipt No: B2 total 22.10 for the ride home tonight'])).toBe(false);
  });

  test('without numbers, a header repeated on every page means one document', () => {
    const head = 'JW MARRIOTT MUMBAI SAHAR TAX INVOICE folio for Ms Rahman';
    expect(sameDocument([`${head} page one lines and charges`, `${head} page two totals and taxes`])).toBe(true);
    expect(sameDocument(['Grab ride 18.40 on Monday from home to the office', 'Gojek ride 25.00 on Tuesday from the office back'])).toBe(false);
  });
});

// The real extractor, in its child process, on a PDF with a text layer — the
// kind the old in-process library could not even open ("bad XRef entry").
describe('pdf/text-extract — the real child process', () => {
  const { extractText } = jest.requireActual('./text-extract');
  test('reads each page of a generated PDF and refuses a file that is not one', async () => {
    const { pdfBuffer } = require('../reports/expense-export');
    const buf = await pdfBuffer({ defaultStyle: { font: 'Helvetica' }, content: [
      { text: 'GRAB Receipt No: A1-77812 Total SGD 18.40 from Orchard Rd to Changi Airport' },
      { text: 'GOJEK Receipt No: B2-99120 Total SGD 22.10 from Changi Airport to Raffles Place', pageBreak: 'before' },
    ] });
    const out = await extractText(buf);
    expect(out.numPages).toBe(2);
    expect(out.pages[0]).toMatch(/A1-77812.*18\.40/);
    expect(out.pages[1]).toMatch(/B2-99120.*22\.10/);
    await expect(extractText(Buffer.from('this is not a pdf'))).rejects.toThrow();
  }, 60000);
});
