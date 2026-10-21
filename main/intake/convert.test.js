// A real HEIC cannot be made here (sharp's libvips reads and writes AV1, not
// HEVC), so the decoder is stood in for, as the plan says; one test below runs
// the real decoder in its worker thread on a file that is not a photo.
jest.mock('heic-decode', () => jest.fn());

const sharp = require('sharp');
const decode = require('heic-decode');
const convert = require('./convert');
const { MAX_BYTES } = require('../receipts/receipt-store');

const canvas = (w, h, background = { r: 200, g: 30, b: 30, alpha: 1 }) => sharp({ create: { width: w, height: h, channels: 4, background } });
const pdfPages = buf => (buf.toString('latin1').match(/\/Type \/Page(?!s)/g) || []).length;
// An ISO-BMFF file as far as the brands go: enough for the sniffer and for
// the stand-in decoder, which never looks further.
const ftyp = (major, ...compatible) => {
  const brands = [major, '\0\0\0\0', ...compatible].join('');
  const box = Buffer.alloc(8 + brands.length);
  box.writeUInt32BE(box.length, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(brands, 8, 'latin1');
  return Buffer.concat([box, Buffer.from('mdat-not-really-an-image')]);
};

describe('intake/convert', () => {
  beforeEach(() => decode.mockReset());

  describe('kept as they came', () => {
    test('a JPEG, a PNG and a PDF pass through byte for byte', async () => {
      const jpeg = await canvas(40, 30).jpeg().toBuffer();
      const png = await canvas(40, 30).png().toBuffer();
      const pdf = Buffer.from('%PDF-1.4\n%junk\n');
      for (const [buf, mime] of [[jpeg, 'image/jpeg'], [png, 'image/png'], [pdf, 'application/pdf']]) {
        const out = await convert.toStorable(buf, { declaredMime: 'image/heic', filename: 'x.heic' });
        expect(out).toEqual({ buffer: buf, mime, convertedFrom: null, note: null });
        expect(out.buffer).toBe(buf);
      }
    });
  });

  describe('converted to a JPEG', () => {
    test.each([
      ['a WebP', 'webp', 'image/webp'],
      ['an AVIF', 'avif', 'image/avif'],
      ['a TIFF of one page', 'tiff', 'image/tiff'],
      ['a GIF', 'gif', 'image/gif'],
    ])('%s becomes a JPEG, and says what it was', async (_label, fmt, mime) => {
      const src = await canvas(300, 400)[fmt]().toBuffer();
      expect(convert.sniff(src)).toBe(mime);
      const out = await convert.toStorable(src, { filename: `r.${fmt}` });
      expect(out).toMatchObject({ mime: 'image/jpeg', convertedFrom: mime, note: null });
      const meta = await sharp(out.buffer).metadata();
      expect(meta).toMatchObject({ format: 'jpeg', width: 300, height: 400 });
    });

    test('a long photo is brought down to 2400 px on its long side, and a small one is not enlarged', async () => {
      const big = await convert.toStorable(await canvas(3000, 1200).webp().toBuffer());
      expect(await sharp(big.buffer).metadata()).toMatchObject({ width: 2400, height: 960 });
      const small = await convert.toStorable(await canvas(120, 80).webp().toBuffer());
      expect(await sharp(small.buffer).metadata()).toMatchObject({ width: 120, height: 80 });
    });

    test('the phone\'s orientation is applied to the pixels and every metadata block is left behind', async () => {
      const src = await canvas(300, 400).webp().withMetadata({ orientation: 6 }).toBuffer();
      const out = await convert.toStorable(src);
      const meta = await sharp(out.buffer).metadata();
      expect(meta).toMatchObject({ width: 400, height: 300 });
      expect(meta.orientation).toBeUndefined();
      expect(meta.exif).toBeUndefined();
    });

    test('a transparent background is laid on white, not black', async () => {
      const src = await canvas(20, 20, { r: 0, g: 0, b: 0, alpha: 0 }).webp({ lossless: true }).toBuffer();
      const out = await convert.toStorable(src);
      const { data } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
      expect(data[0]).toBeGreaterThan(245);
    });

    test('an animated GIF keeps its first frame', async () => {
      const red = await canvas(60, 60, { r: 255, g: 0, b: 0, alpha: 1 }).png().toBuffer();
      const blue = await canvas(60, 60, { r: 0, g: 0, b: 255, alpha: 1 }).png().toBuffer();
      const gif = await sharp([red, blue], { join: { animated: true } }).gif().toBuffer();
      expect((await sharp(gif).metadata()).pages).toBe(2);
      const out = await convert.toStorable(gif);
      const { data } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
      expect(data[0]).toBeGreaterThan(200);
      expect(data[2]).toBeLessThan(60);
    });
  });

  describe('a TIFF of several pages', () => {
    const tiffOf = async (n, w = 300, h = 400) => {
      const pages = [];
      for (let i = 0; i < n; i++) pages.push(await canvas(w, h, { r: (i * 40) % 255, g: 90, b: 90, alpha: 1 }).png().toBuffer());
      return sharp(pages, { join: { animated: true } }).tiff().toBuffer();
    };

    test('becomes a PDF with one page per scan, for the scanned-PDF reader', async () => {
      const out = await convert.toStorable(await tiffOf(3), { filename: 'folio.tif' });
      expect(out).toMatchObject({ mime: 'application/pdf', convertedFrom: 'image/tiff', note: null });
      expect(out.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdfPages(out.buffer)).toBe(3);
      // Sized at the renderer's 150 dpi, so it draws the scan back at its own pixels.
      expect(out.buffer.toString('latin1')).toMatch(/\/MediaBox \[0 0 144 192\]/);
    });

    test('stops at twenty pages and says what was left out', async () => {
      const out = await convert.toStorable(await tiffOf(22, 40, 50));
      expect(pdfPages(out.buffer)).toBe(convert.MAX_TIFF_PAGES);
      expect(out.note).toMatch(/first 20 of the 22 pages/);
    });
  });

  describe('HEIC and HEIF', () => {
    const pixels = (w, h) => new Uint8ClampedArray(w * h * 4).fill(255);

    test('a HEIC is decoded and drawn as a JPEG', async () => {
      decode.mockResolvedValue({ width: 64, height: 48, data: pixels(64, 48) });
      const heic = ftyp('heic', 'mif1', 'heic');
      const out = await convert.toStorable(heic, { filename: 'IMG_0001.HEIC' });
      expect(decode).toHaveBeenCalledWith({ buffer: heic });
      expect(out).toMatchObject({ mime: 'image/jpeg', convertedFrom: 'image/heic' });
      expect(await sharp(out.buffer).metadata()).toMatchObject({ format: 'jpeg', width: 64, height: 48 });
    });

    test('the brands decide: an AVIF that also names mif1 is an AVIF, a bare mif1 is a HEIF', () => {
      expect(convert.sniff(ftyp('mif1', 'mif1', 'heic', 'hevc'))).toBe('image/heic');
      expect(convert.sniff(ftyp('mif1', 'mif1', 'miaf', 'avif'))).toBe('image/avif');
      expect(convert.sniff(ftyp('mif1', 'mif1'))).toBe('image/heif');
      expect(convert.sniff(ftyp('isom', 'mp41'))).toBeNull();     // a video is not a receipt
    });

    test('a HEIC the decoder cannot read is refused with a reason, not a 500', async () => {
      decode.mockRejectedValue(new Error('HEIF image not found'));
      await expect(convert.toStorable(ftyp('heic'), { filename: 'broken.heic' })).rejects.toMatchObject({
        status: 400, message: expect.stringMatching(/"broken\.heic" could not be read as a HEIC image/),
      });
    });

    test('the real decoder runs in a worker thread and reports a bad file back', async () => {
      convert._heicInWorker(true);
      try {
        await expect(convert.decodeHeic(ftyp('heic', 'mif1', 'heic'))).rejects.toThrow();
        expect(decode).not.toHaveBeenCalled();
      } finally {
        convert._heicInWorker(false);
      }
    }, 30000);
  });

  describe('refused', () => {
    test('a BMP is refused, naming what is accepted', async () => {
      const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(60)]);
      expect(convert.sniff(bmp)).toBe('image/bmp');
      await expect(convert.toStorable(bmp, { filename: 'scan.bmp' })).rejects.toMatchObject({
        status: 400, message: expect.stringMatching(/BMP images are not accepted\. Accepted: JPEG, PNG, PDF, HEIC\/HEIF, WebP, TIFF, GIF and AVIF\./),
      });
    });

    test('anything else is refused by name, and an empty or oversized file is said to be one', async () => {
      await expect(convert.toStorable(Buffer.from('<html>hello</html>'), { filename: 'invoice.html' }))
        .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/"invoice\.html" is not a receipt file Solv can read\. Accepted:/) });
      await expect(convert.toStorable(Buffer.alloc(0))).rejects.toMatchObject({ status: 400 });
      await expect(convert.toStorable(Buffer.alloc(MAX_BYTES + 1, 1))).rejects.toMatchObject({ status: 413 });
    });

    test('a file that says it is a WebP and is not one is refused, not stored', async () => {
      const fake = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), Buffer.alloc(40)]);
      await expect(convert.toStorable(fake)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/could not be read as a WebP image/) });
    });
  });

  test('convertibleMime names only the kinds that are converted', async () => {
    expect(convert.convertibleMime(await canvas(10, 10).webp().toBuffer())).toBe('image/webp');
    expect(convert.convertibleMime(await canvas(10, 10).jpeg().toBuffer())).toBeNull();
    expect(convert.convertibleMime(Buffer.from('BM0000'))).toBeNull();
  });
});
