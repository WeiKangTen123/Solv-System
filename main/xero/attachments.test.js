const path = require('path');
const fs = require('fs');

describe('xero/attachments', () => {
  let attachments, receiptStore;
  beforeEach(() => { jest.resetModules(); attachments = require('./attachments'); receiptStore = require('../utils/receipt-store'); });

  test('a small image and a small PDF are attached as they are', async () => {
    const files = receiptStore.forUser('att-user');
    const jpgName = files.save('a1', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 1]), 'image/jpeg');
    const out = await attachments.forReceipt({ id: 'a1', userId: 'att-user', file: jpgName, mime: 'image/jpeg' }, { ref: 'R3' });
    expect(out).toEqual([expect.objectContaining({ name: 'R3.jpg', mime: 'image/jpeg' })]);
    const sample = path.join(__dirname, '../../samples/receipts/jw-marriott-mumbai.pdf');
    if (fs.existsSync(sample)) {
      const pdfName = files.save('a2', fs.readFileSync(sample), 'application/pdf');
      const pdf = await attachments.forReceipt({ id: 'a2', userId: 'att-user', file: pdfName, mime: 'application/pdf' }, { ref: 'R1' });
      expect(pdf).toEqual([expect.objectContaining({ name: 'R1.pdf', mime: 'application/pdf' })]);
      expect(pdf[0].buffer.length).toBeLessThanOrEqual(attachments.MAX_BYTES);
    }
  });

  test('an image over the limit is re-encoded under it', async () => {
    const sharp = require('sharp');
    const big = await sharp({ create: { width: 1800, height: 1800, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png({ compressionLevel: 0 }).toBuffer();
    expect(big.length).toBeGreaterThan(attachments.MAX_BYTES);
    const files = receiptStore.forUser('att-user');
    const name = files.save('a3', big, 'image/png');
    const out = await attachments.forReceipt({ id: 'a3', userId: 'att-user', file: name, mime: 'image/png' }, { ref: 'R2' });
    expect(out).toHaveLength(1);
    expect(out[0].mime).toBe('image/jpeg');
    expect(out[0].buffer.length).toBeLessThanOrEqual(attachments.MAX_BYTES);
  }, 60000);

  test('a missing file yields nothing rather than an error', async () => {
    expect(await attachments.forReceipt({ id: 'x', userId: 'att-user', file: 'gone.jpg', mime: 'image/jpeg' })).toEqual([]);
  });
});
