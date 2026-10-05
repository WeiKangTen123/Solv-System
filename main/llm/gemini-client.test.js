jest.mock('axios');
jest.mock('../store/users', () => ({
  getGeminiKeysForUser: jest.fn(),
  recordKeyUse: jest.fn(),
  findById: jest.fn(() => ({ companyId: 'c1' })),
}));

const axios = require('axios');
const { getGeminiKeysForUser, recordKeyUse } = require('../store/users');

function quotaError() {
  const err = new Error('quota exceeded');
  err.response = { status: 429 };
  return err;
}

function authError() {
  const err = new Error('invalid api key');
  err.response = { status: 401 };
  return err;
}

function okResponse(text) {
  return { data: { choices: [{ message: { content: text } }] } };
}

describe('gemini-client rotation', () => {
  const { callGemini } = require('./gemini-client');

  beforeEach(() => {
    jest.clearAllMocks();
    getGeminiKeysForUser.mockReturnValue([]);
    delete process.env.Gemini_API_KEY;
  });

  test('throws a clear error when no key is configured anywhere', async () => {
    await expect(callGemini('user1', [])).rejects.toThrow('No Gemini API key configured');
  });

  test('falls back to the Gemini_API_KEY environment variable when the company has no keys', async () => {
    process.env.Gemini_API_KEY = 'legacy-key';
    axios.post.mockResolvedValue(okResponse('hi'));

    const result = await callGemini('user1', [{ role: 'user', content: 'hi' }]);
    expect(result).toBe('hi');
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer legacy-key');
  });

  test('rotates through every model on the same key before failing', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockRejectedValue(quotaError());

    await expect(callGemini('user1', [])).rejects.toThrow('quota exceeded');
    // GEMINI_MODELS has 2 entries — both should have been tried on the one key.
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('only moves to the next key once every model on the current key is exhausted', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post
      .mockRejectedValueOnce(quotaError()) // key-1, model A
      .mockRejectedValueOnce(quotaError()) // key-1, model B
      .mockResolvedValueOnce(okResponse('ok from key-2')); // key-2, model A

    const result = await callGemini('user1', []);
    expect(result).toBe('ok from key-2');
    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(axios.post.mock.calls[2][2].headers.Authorization).toBe('Bearer key-2');
  });

  test('a non-quota error fails fast without trying remaining models/keys', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post.mockRejectedValue(authError());

    await expect(callGemini('user1', [])).rejects.toThrow('invalid api key');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('company keys take priority over the environment variable', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-multi' }]);
    process.env.Gemini_API_KEY = 'key-legacy';
    axios.post.mockResolvedValue(okResponse('ok'));

    await callGemini('user1', []);
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer key-multi');
  });

  test('what happened to each stored key is written back to it; the server fallback key has no row', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'k1', id: 7, scope: 'user' }, { apiKey: 'k2', id: 3, scope: 'company' }]);
    axios.post
      .mockRejectedValueOnce(quotaError()).mockRejectedValueOnce(quotaError())   // k1, both models
      .mockResolvedValueOnce(okResponse('ok'));                                   // k2, first model
    await callGemini('user1', []);
    expect(recordKeyUse.mock.calls.map(c => [c[0], c[1], c[2].ok ? 'ok' : c[2].error])).toEqual([
      ['user', 7, 'Out of quota or rate-limited'], ['user', 7, 'Out of quota or rate-limited'], ['company', 3, 'ok'],
    ]);

    recordKeyUse.mockClear();
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'k3', id: 9, scope: 'company' }]);
    axios.post.mockRejectedValueOnce(authError());
    await expect(callGemini('user1', [])).rejects.toThrow('invalid api key');
    expect(recordKeyUse).toHaveBeenCalledWith('company', 9, expect.objectContaining({ error: expect.stringMatching(/Rejected/) }));

    recordKeyUse.mockClear();
    getGeminiKeysForUser.mockReturnValue([]);
    process.env.Gemini_API_KEY = 'env-key';
    axios.post.mockResolvedValueOnce(okResponse('ok'));
    await callGemini('user1', []);
    expect(recordKeyUse).not.toHaveBeenCalled();
  });

  test('a reply cut off at max_tokens is thrown as truncated, not returned as half a JSON', async () => {
    process.env.Gemini_API_KEY = 'legacy-key';
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: '{"receipts": [' }, finish_reason: 'length' }] } });
    await expect(callGemini('user1', [], { maxTokens: 10 })).rejects.toMatchObject({ truncated: true, message: expect.stringMatching(/max_tokens=10/) });
    expect(axios.post).toHaveBeenCalledTimes(1);   // not a quota error, so no rotation
  });
});
