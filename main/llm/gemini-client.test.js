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
  const client = require('./gemini-client');
  const { callGemini } = client;

  beforeEach(() => {
    jest.clearAllMocks();
    client._reset();
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

  test('the fast model is tried on every key before the slow fallback on any', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post
      .mockRejectedValueOnce(quotaError())                  // key-1, fast model
      .mockResolvedValueOnce(okResponse('ok from key-2'));  // key-2, fast model

    const result = await callGemini('user1', []);
    expect(result).toBe('ok from key-2');
    expect(axios.post.mock.calls.map(c => [c[1].model, c[2].headers.Authorization])).toEqual([
      [client.GEMINI_MODELS[0], 'Bearer key-1'], [client.GEMINI_MODELS[0], 'Bearer key-2'],
    ]);
  });

  test('a key that ran out is left alone until Google says, instead of being asked first every time', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    const err = quotaError();
    err.response.data = [{ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '40s' }] } }];
    axios.post.mockRejectedValueOnce(err).mockResolvedValue(okResponse('ok'));
    await callGemini('user1', []);
    await callGemini('user1', []);
    // The second call went straight to key-2: key-1's fast model is cooling.
    expect(axios.post.mock.calls.map(c => c[2].headers.Authorization)).toEqual(['Bearer key-1', 'Bearer key-2', 'Bearer key-2']);
    expect(client._cooling({ apiKey: 'key-1' }, client.GEMINI_MODELS[0])).toBe(true);
  });

  test('when every key and model is cooling, the answer is immediate, not a queue of refusals', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockRejectedValue(quotaError());
    await expect(callGemini('user1', [])).rejects.toThrow('quota exceeded');
    axios.post.mockClear();
    await expect(callGemini('user1', [])).rejects.toMatchObject({ response: { status: 429 } });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a turn can ask for the model it started on', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockResolvedValue({ data: { choices: [{ message: { role: 'assistant', content: 'hi' } }] } });
    const out = await client.chatWithTools('user1', [], [], { model: client.GEMINI_MODELS[1] });
    expect(axios.post.mock.calls[0][1].model).toBe(client.GEMINI_MODELS[1]);
    expect(out.model).toBe(client.GEMINI_MODELS[1]);
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
      .mockRejectedValueOnce(quotaError())        // k1, fast model
      .mockResolvedValueOnce(okResponse('ok'));   // k2, fast model
    await callGemini('user1', []);
    expect(recordKeyUse.mock.calls.map(c => [c[0], c[1], c[2].ok ? 'ok' : c[2].error])).toEqual([
      ['user', 7, 'Out of quota or rate-limited'], ['company', 3, 'ok'],
    ]);

    recordKeyUse.mockClear();
    client._reset();
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'k3', id: 9, scope: 'company' }]);
    axios.post.mockRejectedValueOnce(authError());
    await expect(callGemini('user1', [])).rejects.toThrow('invalid api key');
    expect(recordKeyUse).toHaveBeenCalledWith('company', 9, expect.objectContaining({ error: expect.stringMatching(/Rejected/) }));

    recordKeyUse.mockClear();
    client._reset();
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
