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

  test('when every key and model is cooling, a person waiting is told at once, not queued for refusals', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockRejectedValue(quotaError());
    await expect(callGemini('user1', [])).rejects.toThrow('quota exceeded');
    axios.post.mockClear();
    await expect(callGemini('user1', [], { interactive: true })).rejects.toMatchObject({ response: { status: 429 } });
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

  test('a reply that spent its whole budget before writing anything is cut off, not empty, and carries what was written', async () => {
    process.env.Gemini_API_KEY = 'legacy-key';
    axios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } });
    await expect(callGemini('user1', [])).rejects.toMatchObject({ truncated: true, partial: '' });
    axios.post.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'The total is' }, finish_reason: 'length' }] } });
    await expect(callGemini('user1', [])).rejects.toMatchObject({ truncated: true, partial: 'The total is' });
  });
});

function statusError(code, retryDelay) {
  const err = new Error(`status ${code}`);
  err.response = { status: code };
  if (retryDelay) err.response.data = [{ error: { details: [{ retryDelay }] } }];
  return err;
}
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('gemini-client pacing, waiting and retries', () => {
  const client = require('./gemini-client');
  const { callGemini, GEMINI_MODELS } = client;
  const auth = () => axios.post.mock.calls.map(c => c[2].headers.Authorization);

  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockReset();
    client._reset();
    delete process.env.Gemini_API_KEY;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });
  afterEach(() => { client._reset(); jest.useRealTimers(); });

  test('a background read that finds every key cooling waits for the first to come back', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockRejectedValueOnce(statusError(429, '20s')).mockRejectedValueOnce(statusError(429, '30s'));
    await expect(callGemini('user1', [])).rejects.toMatchObject({ response: { status: 429 } });
    axios.post.mockResolvedValue(okResponse('read'));
    const later = callGemini('user1', []);
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(2);   // nothing is sent while every pair cools
    await jest.advanceTimersByTimeAsync(20_000);
    await expect(later).resolves.toBe('read');
    expect(axios.post.mock.calls[2][1].model).toBe(GEMINI_MODELS[0]);
  });

  test('...but fails at once when nothing comes back within a minute', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockRejectedValue(statusError(429, '120s'));
    await expect(callGemini('user1', [])).rejects.toMatchObject({ response: { status: 429 } });
    axios.post.mockClear();
    await expect(callGemini('user1', [])).rejects.toMatchObject({ response: { status: 429 } });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a key is asked at most fifteen times a minute, whoever shares it and whatever keys they have of their own', async () => {
    const company = { apiKey: 'company', id: 9, scope: 'company' };
    getGeminiKeysForUser.mockImplementation(uid => (uid === 'rich'
      ? [{ apiKey: 'own-1', id: 1, scope: 'user' }, { apiKey: 'own-2', id: 2, scope: 'user' }, { apiKey: 'own-3', id: 3, scope: 'user' }, company]
      : [company]));
    axios.post.mockResolvedValue(okResponse('ok'));
    const plain = Array.from({ length: client.RPM + 5 }, () => callGemini('plain', []));
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(client.RPM);
    // Somebody with three keys of their own asking does not open the company
    // key wider for everyone else.
    await callGemini('rich', []);
    await flush();
    expect(auth().filter(a => a === 'Bearer company')).toHaveLength(client.RPM);
    expect(auth().at(-1)).toBe('Bearer own-1');
    await jest.advanceTimersByTimeAsync(61_000);
    await Promise.all(plain);
    expect(auth().filter(a => a === 'Bearer company')).toHaveLength(client.RPM + 5);
  });

  test('every request a call makes counts against its key, the retries inside one call included', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockRejectedValueOnce(statusError(429)).mockResolvedValue(okResponse('ok'));
    await callGemini('user1', []);   // two requests: the fast model refused, the slow one answered
    const more = Array.from({ length: client.RPM }, () => callGemini('user1', []));
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(client.RPM);
    await jest.advanceTimersByTimeAsync(61_000);
    await Promise.all(more);
    expect(axios.post).toHaveBeenCalledTimes(client.RPM + 2);
  });

  test('background reads never take the last slot: a person waiting is sent at once', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockImplementation(() => new Promise(() => {}));   // every request hangs
    for (let i = 0; i < 6; i++) callGemini('user1', []);
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(4);   // one key has five slots; one is kept back
    client.chatWithTools('user1', [], []);
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(5);
  });

  test('a queue makes room for each key it has', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }, { apiKey: 'key-3' }]);
    axios.post.mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < 20; i++) callGemini('user1', []);
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(11);   // twelve slots for three keys, one kept back
  });

  test('an overloaded model is passed over for the other model before the same one on other keys', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post.mockRejectedValueOnce(statusError(503)).mockResolvedValueOnce(okResponse('ok'));
    await expect(callGemini('user1', [])).resolves.toBe('ok');
    expect(axios.post.mock.calls.map(c => [c[1].model, c[2].headers.Authorization])).toEqual([
      [GEMINI_MODELS[0], 'Bearer key-1'], [GEMINI_MODELS[1], 'Bearer key-1'],
    ]);
  });

  test('a 500, a timeout or a dropped connection is tried once more elsewhere, and the pair is passed over only briefly', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post.mockRejectedValueOnce(statusError(500)).mockResolvedValueOnce(okResponse('ok'));
    await expect(callGemini('user1', [])).resolves.toBe('ok');
    expect(auth()).toEqual(['Bearer key-1', 'Bearer key-2']);
    expect(client._cooling({ apiKey: 'key-1' }, GEMINI_MODELS[0])).toBe(true);
    jest.advanceTimersByTime(6_000);
    expect(client._cooling({ apiKey: 'key-1' }, GEMINI_MODELS[0])).toBe(false);

    axios.post.mockReset();
    const timeout = Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' });
    const dropped = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    axios.post.mockRejectedValueOnce(timeout).mockRejectedValueOnce(dropped).mockResolvedValue(okResponse('never'));
    await expect(callGemini('user1', [])).rejects.toBe(dropped);
    expect(axios.post).toHaveBeenCalledTimes(2);   // once more, not round every pair
  });

  test('once a turn carries tool calls it stays on its model, and is refused rather than sent to another', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    const signed = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG' } } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
    ];
    axios.post.mockRejectedValue(statusError(429, '30s'));
    await expect(client.chatWithTools('user1', signed, [], { model: GEMINI_MODELS[1] })).rejects.toMatchObject({ response: { status: 429 } });
    expect(axios.post.mock.calls.map(c => c[1].model)).toEqual([GEMINI_MODELS[1], GEMINI_MODELS[1]]);   // both keys, never the other model
    axios.post.mockClear();
    await expect(client.chatWithTools('user1', signed, [], { model: GEMINI_MODELS[1] })).rejects.toMatchObject({ response: { status: 429 } });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a caller that gives up cancels the request under way, and nothing else is tried', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    axios.post.mockImplementation((url, body, cfg) => new Promise((resolve, reject) => cfg.signal.addEventListener('abort',
      () => reject(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' })))));
    const gone = new AbortController();
    const asked = client.chatWithTools('user1', [], [], { signal: gone.signal }).catch(err => err);
    await flush();
    gone.abort();
    const err = await asked;
    expect(client.errorKind(err)).toBe('aborted');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('a caller that gives up while waiting leaves the queue', async () => {
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }]);
    axios.post.mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < 5; i++) client.chatWithTools('user1', [], []);   // every slot taken
    const gone = new AbortController();
    const asked = client.chatWithTools('user1', [], [], { signal: gone.signal }).catch(err => err);
    await flush();
    gone.abort();
    expect(client.errorKind(await asked)).toBe('aborted');
    expect(axios.post).toHaveBeenCalledTimes(5);
  });

  test('errors are classified once, for the routes to put into words', () => {
    const kind = client.errorKind;
    expect(kind(statusError(429))).toBe('quota');
    expect(kind(statusError(503))).toBe('quota');
    expect(kind(statusError(401))).toBe('auth');
    expect(kind(statusError(500))).toBe('transient');
    expect(kind(statusError(400))).toBeNull();
    expect(kind(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('transient');
    expect(kind(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }))).toBe('transient');
    expect(kind(new Error('No Gemini API key configured — add one in Settings'))).toBe('no-key');
    expect(kind(new DOMException('gone', 'AbortError'))).toBe('aborted');
    expect(kind(new Error('Gemini returned empty response'))).toBeNull();
  });
});

describe('gemini-client streaming', () => {
  const client = require('./gemini-client');
  const realFetch = global.fetch;
  const enc = new TextEncoder();
  const sse = (...parts) => new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const ev = obj => `data: ${JSON.stringify(obj)}`;
  const text = t => ev({ choices: [{ delta: { content: t } }] });
  const ask = (opts = {}) => {
    const heard = [];
    return client.chatWithTools('user1', [], [], { onText: t => heard.push(t), ...opts }).then(out => ({ out, heard }));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    client._reset();
    getGeminiKeysForUser.mockReturnValue([{ apiKey: 'key-1' }, { apiKey: 'key-2' }]);
    global.fetch = jest.fn();
  });
  afterAll(() => { global.fetch = realFetch; });

  test('lines ending in \\r\\n are read, even when a chunk ends between the \\r and the \\n', async () => {
    global.fetch.mockResolvedValueOnce(sse(`${text('Hel')}\r\n\r`, `\n${text('lo')}\r\n\r\n`));
    const { out, heard } = await ask();
    expect(out.content).toBe('Hello');
    expect(heard).toEqual(['Hel', 'lo']);
  });

  test('the last event counts even without the blank line after it', async () => {
    global.fetch.mockResolvedValueOnce(sse(`${text('Hel')}\n\n${text('lo')}`));
    expect((await ask()).out.content).toBe('Hello');
  });

  test('pieces of one call are joined, and a new id at the same index is a new call', async () => {
    const tc = (index, id, name, args) => ev({ choices: [{ delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), arguments: args } }] } }] });
    global.fetch.mockResolvedValueOnce(sse(`${tc(0, 'a', 'get_receipt', '{"id":')}\n\n${tc(0, null, null, '"r1"}')}\n\n${tc(0, 'b', 'check_receipt', '{"id":"r2"}')}\n\n`));
    const { out } = await ask();
    expect(out.tool_calls.map(c => [c.id, c.function.name, JSON.parse(c.function.arguments)])).toEqual([
      ['a', 'get_receipt', { id: 'r1' }], ['b', 'check_receipt', { id: 'r2' }],
    ]);
  });

  test('an error part-way through fails the call instead of passing off the text so far as the answer', async () => {
    global.fetch.mockResolvedValueOnce(sse(`${text('The total is')}\n\n${ev({ error: { code: 503, message: 'overloaded' } })}\n\n`));
    await expect(ask()).rejects.toThrow(/overloaded/);
    // Words had reached the person; asking elsewhere would show them twice.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('an error before any text is asked of the other model', async () => {
    global.fetch
      .mockResolvedValueOnce(sse(`${ev({ error: { code: 503, message: 'overloaded' } })}\n\n`))
      .mockResolvedValueOnce(sse(`${text('Hello')}\n\n`));
    expect((await ask()).out.content).toBe('Hello');
    expect(global.fetch.mock.calls.map(c => JSON.parse(c[1].body).model)).toEqual([client.GEMINI_MODELS[0], client.GEMINI_MODELS[1]]);
  });

  test('the caller\'s signal reaches the request', async () => {
    global.fetch.mockResolvedValueOnce(sse(`${text('Hi')}\n\n`));
    const gone = new AbortController();
    await ask({ signal: gone.signal });
    const signal = global.fetch.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    gone.abort();
    expect(signal.aborted).toBe(true);
  });
});
