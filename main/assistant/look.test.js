jest.mock('../llm/gemini-client', () => ({ callGemini: jest.fn() }));
jest.mock('../receipts/receipt-store', () => ({ forUser: () => ({ read: () => Buffer.from([0xff, 0xd8, 0xff]) }) }));
jest.mock('../receipts/image-prep', () => ({ imagePart: async () => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }) }));

const { callGemini } = require('../llm/gemini-client');
const { lookAt } = require('./look');

describe('looking at a receipt', () => {
  const e = { id: 'e1', receipt: { userId: 'u1', file: 'r.jpg', mime: 'image/jpeg' } };
  beforeEach(() => callGemini.mockReset());

  test('has room for a long answer, and passes the caller\'s signal on', async () => {
    callGemini.mockResolvedValueOnce('  SGD 120.00  ');
    const signal = new AbortController().signal;
    expect(await lookAt('u1', e, 'total?', { interactive: true, signal })).toBe('SGD 120.00');
    expect(callGemini.mock.calls[0][2]).toMatchObject({ maxTokens: 2048, interactive: true, signal });
  });

  test('an answer cut off at the budget is kept, and says it was cut short', async () => {
    callGemini.mockRejectedValueOnce(Object.assign(new Error('cut off'), { truncated: true, partial: 'Lines: room 100, breakfast 20, ' }));
    expect(await lookAt('u1', e, 'every line?')).toBe('Lines: room 100, breakfast 20, …[cut short]');
  });

  test('one cut off before it wrote anything, or any other failure, is still a failure', async () => {
    callGemini.mockRejectedValueOnce(Object.assign(new Error('cut off'), { truncated: true, partial: '' }));
    await expect(lookAt('u1', e, 'every line?')).rejects.toMatchObject({ truncated: true });
    callGemini.mockRejectedValueOnce(Object.assign(new Error('quota'), { response: { status: 429 } }));
    await expect(lookAt('u1', e, 'total?')).rejects.toThrow('quota');
  });
});
