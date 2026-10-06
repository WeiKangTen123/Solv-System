// Large photos are shrunk before they are sent to the model; small ones and
// PDFs are sent as they are.
const sharp = require('sharp');
const { forModel, MAX_SIDE } = require('./image-prep');

describe('receipts/image-prep', () => {
  test('a large photo comes back smaller, at most MAX_SIDE on its long side, keeping its orientation tag', async () => {
    const noise = Buffer.alloc(4000 * 3000 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const big = await sharp(noise, { raw: { width: 4000, height: 3000, channels: 3 } }).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
    expect(big.length).toBeGreaterThan(1.5 * 1024 * 1024);
    const out = await forModel(big, 'image/jpeg');
    expect(out.buffer.length).toBeLessThan(big.length);
    const meta = await sharp(out.buffer).metadata();
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(MAX_SIDE);
    expect(meta.orientation).toBe(6);
  });

  test('a small photo and a PDF are left alone', async () => {
    const small = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect((await forModel(small, 'image/jpeg')).buffer).toBe(small);
    const pdf = Buffer.alloc(2 * 1024 * 1024, 1);
    expect((await forModel(pdf, 'application/pdf')).buffer).toBe(pdf);
  });
});
