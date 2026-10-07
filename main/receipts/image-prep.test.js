// Large photos are shrunk before they are sent to the model; small ones and
// PDFs are sent as they are.
const sharp = require('sharp');
const { forModel, MAX_SIDE } = require('./image-prep');

describe('receipts/image-prep', () => {
  // The orientation is applied to the pixels and the metadata dropped: kept,
  // it carried the GPS position the photo was taken at to Google.
  test('a large photo comes back smaller, at most MAX_SIDE on its long side, upright, with no metadata', async () => {
    const noise = Buffer.alloc(4000 * 3000 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const big = await sharp(noise, { raw: { width: 4000, height: 3000, channels: 3 } }).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
    expect(big.length).toBeGreaterThan(1.5 * 1024 * 1024);
    const out = await forModel(big, 'image/jpeg');
    expect(out.buffer.length).toBeLessThan(big.length);
    const meta = await sharp(out.buffer).metadata();
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(MAX_SIDE);
    expect(meta.height).toBeGreaterThan(meta.width);          // 4000x3000 tagged "rotate 90" is portrait
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  test('a large transparent PNG is shrunk onto white, not onto JPEG\'s black', async () => {
    // Noise in the colour channels keeps the PNG over the size that is shrunk;
    // every pixel is fully transparent, so all that shows is the paper.
    const w = 1000, h = 1000;
    const raw = require('crypto').randomBytes(w * h * 4);
    for (let i = 3; i < raw.length; i += 4) raw[i] = 0;
    const png = await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    expect(png.length).toBeGreaterThan(1.5 * 1024 * 1024);
    const out = await forModel(png, 'image/png');
    expect(out.mime).toBe('image/jpeg');
    const { channels } = await sharp(out.buffer).stats();
    for (const c of channels.slice(0, 3)) expect(c.mean).toBeGreaterThan(250);
  });

  test('a small photo and a PDF are left alone', async () => {
    const small = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect((await forModel(small, 'image/jpeg')).buffer).toBe(small);
    const pdf = Buffer.alloc(2 * 1024 * 1024, 1);
    expect((await forModel(pdf, 'application/pdf')).buffer).toBe(pdf);
  });
});
