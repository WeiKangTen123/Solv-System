const axios  = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

// Gemini, through Google's OpenAI-compatible endpoint. Both models take the
// same request; only the `model` field differs, so moving between them on a
// quota error is a same-shape retry, not a provider switch.
const GEMINI_URL    = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
// Fastest first. The second is a fallback, and a slow one: about 5–7 s for a
// call the first answers in about 1 s.
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

// ── Keys ─────────────────────────────────────────────────────────────────────
// The person's own keys, then their company's, in rotation order
// (store/users.js getGeminiKeysForUser); the server's own .env key only when
// neither has any. Resolved once every half-minute rather than on every call:
// each resolution decrypts every key.
const KEY_TTL_MS = 30_000;
const _keyCache = new Map();
function _resolveKeys(userId) {
  const slot = String(userId || '');
  const hit = _keyCache.get(slot);
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.keys;
  const keys = [];
  if (userId) {
    const { getGeminiKeysForUser } = require('../store/users');
    for (const row of getGeminiKeysForUser(userId)) keys.push({ apiKey: row.apiKey, id: row.id ?? null, scope: row.scope || null });
  }
  if (!keys.length && process.env.Gemini_API_KEY) keys.push({ apiKey: process.env.Gemini_API_KEY, id: null, scope: 'env' });
  if (!keys.length) throw new Error('No Gemini API key configured — add one in Settings');
  _keyCache.set(slot, { at: Date.now(), keys });
  return keys;
}
// Called when a key is added or removed, so the change applies at once.
function forgetKeys() { _keyCache.clear(); }
function hasKeys(userId) { try { return _resolveKeys(userId).length > 0; } catch { return false; } }

// What happened to a stored key, written back to it for Settings to show.
// The server's own fallback key has no row. Never allowed to fail a read.
function _record(key, result) {
  if (!key || !key.id || !key.scope || key.scope === 'env') return;
  try {
    const users = require('../store/users');
    if (typeof users.recordKeyUse === 'function') users.recordKeyUse(key.scope, key.id, result);
  } catch { /* status is a convenience */ }
}

// ── What went wrong ──────────────────────────────────────────────────────────
// One reading of a failed call, for the rotation below and for the routes
// that put it into words (routes/assistant.js):
//   quota      429 out of quota, or 503 overloaded: another key or model may answer
//   auth       401 or 403: the key itself was refused
//   transient  any other 5xx, a timeout or a dropped connection: worth one more try
//   no-key     no key is configured anywhere
//   aborted    the caller gave up, as when a tab is closed mid-answer
//   null       anything else, such as a bad request, which would fail the same way everywhere
const _DROPPED = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
function errorKind(err) {
  if (!err) return null;
  if (err.name === 'AbortError' || err.name === 'CanceledError') return 'aborted';
  const status = err.response && err.response.status;
  if (status === 429 || status === 503) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'transient';
  if (status) return null;
  if (/No Gemini API key/.test(String(err.message || ''))) return 'no-key';
  if (err.name === 'TimeoutError' || _DROPPED.has(err.code) || _DROPPED.has(err.cause && err.cause.code)) return 'transient';
  return null;
}

// ── Cooldowns ────────────────────────────────────────────────────────────────
// A key and model that just answered 429 (out of quota) or 503 (overloaded)
// is left alone until Google says it may be asked again. Without this every
// call tried the exhausted pair first and paid a wasted round trip for it,
// and a key whose fast model had run out went straight to its slow model
// while the next key's fast model sat unused.
const _cool = new Map();
const _keyTag = key => (key.id != null ? `${key.scope}:${key.id}` : `h:${crypto.createHash('sha256').update(key.apiKey).digest('hex').slice(0, 12)}`);
const _coolTag = (key, model) => `${_keyTag(key)}|${model}`;
const _coolUntil = (key, model) => _cool.get(_coolTag(key, model)) || 0;
function _cooling(key, model, now = Date.now()) { return _coolUntil(key, model) > now; }
function _retryDelayMs(err) {
  const data = err.response?.data;
  const details = (Array.isArray(data) ? data[0]?.error?.details : data?.error?.details) || [];
  const info = details.find(x => x && typeof x.retryDelay === 'string');
  const m = info && /^(\d+(?:\.\d+)?)s$/.exec(info.retryDelay);
  if (m) return Math.min(Math.max(Number(m[1]) * 1000, 1000), 60 * 60 * 1000);
  const after = Number(err.response?.headers?.['retry-after']);
  if (after > 0) return Math.min(after * 1000, 60 * 60 * 1000);
  return err.response?.status === 503 ? 15_000 : 60_000;
}
function _coolDown(key, model, ms) { _cool.set(_coolTag(key, model), Date.now() + ms); }
// A 500, a timeout or a dropped connection says nothing about the key's
// quota: the pair is passed over briefly, not for a minute.
const TRANSIENT_COOL_MS = 5_000;
// A background read that finds every key and model cooling waits for the
// first to come back, if that is within a minute, instead of failing at once
// and leaving the receipt blank. A person waiting is told at once.
const MAX_COOL_WAIT_MS = 60_000;

function _allCooling() {
  const err = new Error('Every LLM key is out of quota for the moment');
  err.response = { status: 429 };
  return err;
}

// ── Pacing: each key's own minute, and a queue per set of keys ───────────────
// Google's per-minute quota belongs to a key, so the count does too: every
// request sent on a key is one of its fifteen a minute, whoever sent it and
// whether or not it was a retry. The queue in front is shared by everyone
// with the same keys: a company's people, or one person with keys of their
// own. It used to be one queue per company, sized by the key count of
// whoever had called last, so one person's three keys of their own let the
// whole company send four keys' worth through the one company key.
//
// A person waiting for the assistant goes ahead of receipts being read in
// the background, and background work never holds the last slot: one
// assistant step used to wait a minute behind twenty photos.
const RPM           = 15;
const RPM_WINDOW_MS = 60_000;
// Requests in flight per queue: room for each key, within a floor and a
// ceiling (a request can carry several photos).
const CONCURRENT_PER_KEY = 4;
const MIN_CONCURRENT     = 5;
const MAX_CONCURRENT     = 16;
const _concurrency = keyCount => Math.min(MAX_CONCURRENT, Math.max(MIN_CONCURRENT, CONCURRENT_PER_KEY * keyCount));

const _sent = new Map();   // key tag → when each of its requests in the last minute was sent
function _window(key, now) {
  const tag = _keyTag(key);
  let w = _sent.get(tag);
  if (!w) _sent.set(tag, (w = []));
  while (w.length && w[0] <= now - RPM_WINDOW_MS) w.shift();
  return w;
}
// When the key next has room in its minute: now, or when its oldest request leaves.
function _roomAt(key, now = Date.now()) {
  const w = _window(key, now);
  return w.length < RPM ? now : w[w.length - RPM] + RPM_WINDOW_MS + 5;
}
function _send(key, now = Date.now()) { _window(key, now).push(now); }

class Limiter {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.queue = []; this.running = 0; this.background = 0;
    this._timer = null; this._timerAt = 0;
  }
  // wait() says how long until the job can go (0 for now), or throws to turn
  // it away. A signal that aborts takes a waiting job out of the queue.
  enqueue(fn, { interactive = false, wait = null, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(signal.reason); return; }
      const item = { fn, resolve, reject, interactive, wait, off: null };
      if (signal) {
        const onAbort = () => {
          const at = this.queue.indexOf(item);
          if (at >= 0) { this.queue.splice(at, 1); reject(signal.reason); }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        item.off = () => signal.removeEventListener('abort', onAbort);
      }
      if (interactive) {
        // Behind other people waiting, ahead of background work.
        const at = this.queue.findIndex(x => !x.interactive);
        if (at === -1) this.queue.push(item); else this.queue.splice(at, 0, item);
      } else this.queue.push(item);
      this._drain();
    });
  }
  _drain() {
    while (this.queue.length) {
      const item = this.queue[0];
      if (this.running >= this.maxConcurrent) return;
      // Background work leaves the last slot for a person waiting.
      if (!item.interactive && this.background >= Math.max(1, this.maxConcurrent - 1)) return;
      let waitMs = 0;
      try { waitMs = item.wait ? item.wait() : 0; }
      catch (err) { this.queue.shift(); if (item.off) item.off(); item.reject(err); continue; }
      if (waitMs > 0) { this._wake(waitMs); return; }
      this.queue.shift();
      if (item.off) item.off();
      this.running++;
      if (!item.interactive) this.background++;
      item.fn().then(item.resolve, item.reject).finally(() => {
        this.running--;
        if (!item.interactive) this.background--;
        this._drain();
      });
    }
  }
  _wake(ms) {
    const at = Date.now() + ms;
    if (this._timer && this._timerAt <= at) return;
    clearTimeout(this._timer);
    this._timerAt = at;
    this._timer = setTimeout(() => { this._timer = null; this._drain(); }, ms);
    logger.info(`Gemini keys busy or cooling down — next try in ${Math.ceil(ms / 1000)}s`);
  }
  _stop() { clearTimeout(this._timer); this._timer = null; }
}
const _limiters = new Map();
function _limiterFor(keys) {
  const id = keys.map(_keyTag).sort().join(',');
  let l = _limiters.get(id);
  if (!l) _limiters.set(id, (l = new Limiter(_concurrency(keys.length))));
  return l;
}

// ── One request ──────────────────────────────────────────────────────────────

function _body(model, messages, opts) {
  const body = { model, messages, temperature: opts.temperature ?? 0, max_tokens: opts.maxTokens ?? 800 };
  if (opts.tools) { body.tools = opts.tools; body.tool_choice = opts.toolChoice || 'auto'; }
  return body;
}

async function _callOnce(model, key, messages, opts) {
  const response = await axios.post(GEMINI_URL, _body(model, messages, opts), {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: opts.timeoutMs ?? 120_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const choice = response.data.choices?.[0];
  // With tools, the whole message is the answer: it may be tool calls and no
  // text. Each tool call carries Google's thought signature, which has to go
  // back verbatim with the call or the next request is refused.
  if (opts.tools) {
    if (!choice?.message || (!choice.message.content && !(choice.message.tool_calls || []).length)) throw new Error(`Gemini returned empty response (model: ${model})`);
    return { ...choice.message, truncated: choice.finish_reason === 'length' };
  }
  // A reply that ran into max_tokens is half a JSON document. Returned, it
  // failed to parse and the receipt was left blank with nothing saying why;
  // thrown with a flag, the reader can ask again with a larger budget, and a
  // caller that can use part of an answer has what was written. Checked
  // before an empty reply: a model that spent the budget thinking wrote
  // nothing, and that is a reply cut off, not an empty one.
  if (choice?.finish_reason === 'length') {
    const err = new Error(`Gemini reply was cut off at max_tokens=${opts.maxTokens ?? 800} (model: ${model})`);
    err.truncated = true;
    err.partial = choice.message?.content || '';
    throw err;
  }
  if (!choice?.message?.content) throw new Error(`Gemini returned empty response (model: ${model})`);
  return choice.message.content;
}

// The same request, streamed: text is handed to opts.onText as it is
// written, and the whole message is returned at the end. Only a failure
// before the first word is retried on another key or model; one after it
// would show the person the same words twice, so it is marked `streamed`.
async function _streamOnce(model, key, messages, opts) {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ..._body(model, messages, opts), stream: true }),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  if (!res.ok) {
    let data = null; try { data = await res.json(); } catch { /* not JSON */ }
    const err = new Error(`Gemini answered ${res.status} (model: ${model})`);
    err.response = { status: res.status, data, headers: Object.fromEntries(res.headers.entries()) };
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', content = '', truncated = false;
  const calls = [];
  const take = chunk => {
    // An error part-way through is a failure. It used to end the loop like
    // the end of the stream, and the text so far went out as the answer.
    if (chunk.error) {
      const code = Number(chunk.error.code);
      const err = new Error(`Gemini stream failed: ${chunk.error.message || chunk.error.status || 'unknown error'} (model: ${model})`);
      if (code >= 400 && code < 600) err.response = { status: code, data: chunk, headers: {} };
      throw err;
    }
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return;
    if (choice.finish_reason === 'length') truncated = true;
    const d = choice.delta || {};
    if (d.content) { content += d.content; try { opts.onText && opts.onText(d.content); } catch { /* a closed client */ } }
    for (const tc of d.tool_calls || []) {
      // Pieces of one call share an index; a call sent whole has none. A new
      // id is a new call even at an index already used: Gemini can number
      // whole calls 0, one after another, and their arguments were being
      // run together into one.
      const at = Number.isInteger(tc.index) ? calls.findLastIndex(c => c._index === tc.index) : -1;
      if (at === -1 || (tc.id && calls[at].id && tc.id !== calls[at].id)) {
        calls.push({ ...tc, _index: tc.index, function: { name: tc.function?.name, arguments: tc.function?.arguments || '' } });
      } else {
        const c = calls[at];
        if (tc.function?.name) c.function.name = tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
        if (tc.extra_content) c.extra_content = tc.extra_content;
        if (tc.id) c.id = tc.id;
      }
    }
  };
  // Events end at a blank line. Lines may end in \r\n, and the last event can
  // arrive without its blank line when the stream closes.
  const events = final => {
    buf = buf.replace(/\r\n/g, '\n');
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0 || (final && buf)) {
      const event = cut >= 0 ? buf.slice(0, cut) : buf;
      buf = cut >= 0 ? buf.slice(cut + 2) : '';
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; /* not an event of ours */ }
        take(chunk);
      }
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      events(false);
    }
    buf += decoder.decode();
    events(true);
  } catch (err) {
    if (content) err.streamed = true;
    throw err;
  }
  const tool_calls = calls.map(({ _index, ...c }) => c);
  if (!content && !tool_calls.length) throw new Error(`Gemini returned empty response (model: ${model})`);
  return { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}), truncated };
}

// Messages that carry tool calls carry Google's thought signatures with them,
// and only the model that made a signature accepts it.
const _signed = messages => (messages || []).some(m => m && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);

// ── Rotation ─────────────────────────────────────────────────────────────────
// Fast model first on EVERY key, then the slow one, skipping any pair that is
// cooling down. A 503 is the model overloaded for everyone, so the other
// model is asked before the same one on the remaining keys. A transient
// failure (a 500, a timeout, a dropped connection) is tried once more on the
// next pair. Anything else (a bad request, a refused key) fails fast instead
// of burning through every pair on a request that would fail the same way
// everywhere.
//
// opts.model puts one model first. Once the messages carry tool calls it is
// the only model asked: Google signs each call for the model that made it,
// and another model would be sent signatures it refuses.
async function callGemini(userId, messages, opts = {}) {
  const keys = _resolveKeys(userId);
  const interactive = !!opts.interactive;
  const pinned = opts.model && GEMINI_MODELS.includes(opts.model) ? opts.model : null;
  const models = !pinned ? GEMINI_MODELS
    : _signed(messages) ? [pinned]
    : [pinned, ...GEMINI_MODELS.filter(m => m !== pinned)];
  const once = opts.onText ? _streamOnce : _callOnce;

  // When the request can go: as soon as one of its keys has room in its
  // minute and a model that is not cooling down.
  let coolWaitUntil = 0;
  const wait = () => {
    const now = Date.now();
    let ready = Infinity, back = Infinity, allCooling = true;
    for (const key of keys) {
      const room = _roomAt(key, now);
      for (const model of models) {
        const until = _coolUntil(key, model);
        if (until > now) back = Math.min(back, until); else allCooling = false;
        ready = Math.min(ready, Math.max(room, until));
      }
    }
    if (allCooling) {
      // Every pair is cooling down. A person is told so at once rather than
      // kept waiting on a request that would only be refused.
      if (interactive) throw _allCooling();
      coolWaitUntil = coolWaitUntil || now + MAX_COOL_WAIT_MS;
      if (back > coolWaitUntil) throw _allCooling();
    }
    return Math.max(0, ready - now);
  };

  return _limiterFor(keys).enqueue(async () => {
    const pairs = models.flatMap(model => keys.map(key => ({ model, key, late: false })));
    let lastErr = null, tried = 0, retried = false;
    for (let i = 0; i < pairs.length; i++) {
      const { model, key, late } = pairs[i];
      const now = Date.now();
      if (_cooling(key, model, now)) continue;
      // A key that has had its fifteen this minute is asked last rather
      // than skipped: the request is already under way.
      if (!late && _roomAt(key, now) > now) { pairs.push({ model, key, late: true }); continue; }
      const k = keys.indexOf(key);
      _send(key, now);
      tried++;
      try {
        const out = await once(model, key.apiKey, messages, opts);
        _record(key, { ok: true, model });
        if (out && typeof out === 'object') out.model = model;
        return out;
      } catch (err) {
        if (opts.signal && opts.signal.aborted) opts.signal.throwIfAborted();
        lastErr = err;
        const kind = errorKind(err);
        if (kind === 'quota') {
          const status = err.response.status;
          _coolDown(key, model, _retryDelayMs(err));
          _record(key, { error: status === 503 ? 'Busy at Google; tried another' : 'Out of quota or rate-limited', model });
          logger.warn(`Gemini ${status} on ${model} (key ${k + 1}/${keys.length}) — rotating`, { userId });
          if (status === 503) {
            const rest = pairs.splice(i + 1);
            pairs.push(...rest.filter(p => p.model !== model), ...rest.filter(p => p.model === model));
          }
          if (!err.streamed) continue;
        } else if (kind === 'transient' && !retried && !err.streamed) {
          retried = true;
          _coolDown(key, model, TRANSIENT_COOL_MS);
          logger.warn(`Gemini ${err.response?.status || err.code || err.name} on ${model} (key ${k + 1}/${keys.length}) — trying once more`, { userId });
          continue;
        }
        // A refused key is the key's problem; a cut-off reply or a bad
        // request is not, and must not mark a working key as broken.
        if (kind === 'auth') _record(key, { error: 'Rejected by Google: the key is invalid or not enabled', model });
        throw err;
      }
    }
    if (!tried) throw _allCooling();
    throw lastErr;
  }, { interactive, wait, signal: opts.signal || null });
}

// One turn of a conversation that may call tools: the same keys, models,
// rotation and pacing as the reader, returning the model's whole message
// ({ content, tool_calls, truncated, model }) rather than its text. Asked as
// interactive, so it goes ahead of receipts being read.
function chatWithTools(userId, messages, tools, opts = {}) {
  return callGemini(userId, messages, { interactive: true, ...opts, tools });
}

async function testGeminiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) throw new Error('API key is required');
  const key = apiKey.trim();
  const testModels = [...GEMINI_MODELS, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastErr = null;
  for (const model of testModels) {
    const t0 = Date.now();
    try {
      const response = await axios.post(
        GEMINI_URL,
        { model, messages: [{ role: 'user', content: 'Ping' }], max_tokens: 5 },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 15_000 },
      );
      if (response.data?.choices?.[0]?.message) {
        // latencyMs: the Profile screen has always printed it, and it read
        // "undefinedms" because it was never returned.
        return { ok: true, model, latencyMs: Date.now() - t0 };
      }
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 401 || status === 403) throw new Error('Invalid Gemini API key. Please check the key from Google AI Studio.');
      if (status === 429) throw new Error('Gemini API key quota exceeded or rate limited.');
    }
  }
  const msg = lastErr?.response?.data?.error?.message || lastErr?.message || 'Could not verify Gemini API key';
  throw new Error(`Gemini test failed: ${msg}`);
}

function _reset() {
  _keyCache.clear(); _cool.clear(); _sent.clear();
  for (const l of _limiters.values()) l._stop();
  _limiters.clear();
}

module.exports = { callGemini, chatWithTools, testGeminiKey, hasKeys, forgetKeys, errorKind, GEMINI_MODELS, RPM, _reset, _cooling };
