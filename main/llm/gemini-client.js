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
const _isAuthError  = err => [401, 403].includes(err.response?.status);
const _isQuotaError = err => [429, 503].includes(err.response?.status);

// ── Cooldowns ────────────────────────────────────────────────────────────────
// A key and model that just answered 429 (out of quota) or 503 (overloaded)
// is left alone until Google says it may be asked again. Without this every
// call tried the exhausted pair first and paid a wasted round trip for it,
// and a key whose fast model had run out went straight to its slow model
// while the next key's fast model sat unused.
const _cool = new Map();
const _keyTag = key => (key.id != null ? `${key.scope}:${key.id}` : `h:${crypto.createHash('sha256').update(key.apiKey).digest('hex').slice(0, 12)}`);
const _coolTag = (key, model) => `${_keyTag(key)}|${model}`;
function _cooling(key, model, now = Date.now()) { const until = _cool.get(_coolTag(key, model)); return !!until && until > now; }
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
function _coolDown(key, model, err) { _cool.set(_coolTag(key, model), Date.now() + _retryDelayMs(err)); }

// ── Rate limiter, per company: a lane for people waiting, then the rest ──────
// One queue per company, sized to Google's per-minute quota for each key it
// has. A person waiting for the assistant goes ahead of receipts being read
// in the background: one assistant step used to wait a minute behind twenty
// photos.
const RPM            = 15;
const RPM_WINDOW_MS  = 60_000;
const MAX_CONCURRENT = 5;

class Limiter {
  constructor(rpm, windowMs, maxConcurrent) {
    this.rpm = rpm; this.windowMs = windowMs; this.maxConcurrent = maxConcurrent;
    this.timestamps = []; this.queue = []; this.running = 0; this._drainTimer = null;
  }
  enqueue(fn, { interactive = false } = {}) {
    return new Promise((resolve, reject) => {
      const item = { fn, resolve, reject, interactive };
      if (interactive) {
        // Behind other people waiting, ahead of background work.
        const at = this.queue.findIndex(x => !x.interactive);
        if (at === -1) this.queue.push(item); else this.queue.splice(at, 0, item);
      } else this.queue.push(item);
      this._drain();
    });
  }
  _drain() {
    while (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const now = Date.now();
      const cutoff = now - this.windowMs;
      while (this.timestamps.length && this.timestamps[0] <= cutoff) this.timestamps.shift();
      if (this.timestamps.length >= this.rpm) {
        if (!this._drainTimer) {
          const waitMs = this.timestamps[0] + this.windowMs - now + 5;
          this._drainTimer = setTimeout(() => { this._drainTimer = null; this._drain(); }, waitMs);
          logger.info(`Gemini rate limit reached — next slot in ${Math.ceil(waitMs / 1000)}s`);
        }
        return;
      }
      const { fn, resolve, reject } = this.queue.shift();
      this.timestamps.push(Date.now());
      this.running++;
      fn().then(resolve, reject).finally(() => { this.running--; this._drain(); });
    }
  }
}
const _limiters = new Map();
function _limiterKey(userId) {
  if (!userId) return 'default';
  try { const u = require('../store/users').findById(userId); return u ? `company:${u.companyId}` : String(userId); }
  catch { return String(userId); }
}
function _getLimiter(userId, keyCount = 1) {
  const key = _limiterKey(userId);
  if (!_limiters.has(key)) _limiters.set(key, new Limiter(RPM, RPM_WINDOW_MS, MAX_CONCURRENT));
  const l = _limiters.get(key);
  l.rpm = RPM * Math.max(1, keyCount);
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
  });
  const choice = response.data.choices?.[0];
  // With tools, the whole message is the answer: it may be tool calls and no
  // text. Each tool call carries Google's thought signature, which has to go
  // back verbatim with the call or the next request is refused.
  if (opts.tools) {
    if (!choice?.message || (!choice.message.content && !(choice.message.tool_calls || []).length)) throw new Error(`Gemini returned empty response (model: ${model})`);
    return { ...choice.message, truncated: choice.finish_reason === 'length' };
  }
  if (!choice?.message?.content) throw new Error(`Gemini returned empty response (model: ${model})`);
  // A reply that ran into max_tokens is half a JSON document. Returned, it
  // failed to parse and the receipt was left blank with nothing saying why;
  // thrown with a flag, the reader can ask again with a larger budget.
  if (choice.finish_reason === 'length') {
    const err = new Error(`Gemini reply was cut off at max_tokens=${opts.maxTokens ?? 800} (model: ${model})`);
    err.truncated = true;
    throw err;
  }
  return choice.message.content;
}

// The same request, streamed: text is handed to opts.onText as it is
// written, and the whole message is returned at the end. Only a failure
// before the first byte is retried on another key or model; one mid-stream
// would show the person the same words twice.
async function _streamOnce(model, key, messages, opts) {
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ..._body(model, messages, opts), stream: true }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
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
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return;
    if (choice.finish_reason === 'length') truncated = true;
    const d = choice.delta || {};
    if (d.content) { content += d.content; try { opts.onText && opts.onText(d.content); } catch { /* a closed client */ } }
    for (const tc of d.tool_calls || []) {
      // Pieces of one call share an index; a call sent whole has none.
      const at = Number.isInteger(tc.index) ? calls.findIndex(c => c._index === tc.index) : -1;
      if (at === -1) calls.push({ ...tc, _index: tc.index, function: { name: tc.function?.name, arguments: tc.function?.arguments || '' } });
      else {
        const c = calls[at];
        if (tc.function?.name) c.function.name = tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
        if (tc.extra_content) c.extra_content = tc.extra_content;
        if (tc.id) c.id = tc.id;
      }
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, cut); buf = buf.slice(cut + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try { take(JSON.parse(data)); } catch { /* a keep-alive or a partial line */ }
      }
    }
  }
  const tool_calls = calls.map(({ _index, ...c }) => c);
  if (!content && !tool_calls.length) throw new Error(`Gemini returned empty response (model: ${model})`);
  return { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}), truncated };
}

// ── Rotation ─────────────────────────────────────────────────────────────────
// Fast model first on EVERY key, then the slow one, skipping any pair that is
// cooling down. A non-quota error (bad request, refused key) fails fast
// instead of burning through every pair on a request that would fail the
// same way everywhere. opts.model puts one model first — a conversation turn
// stays on the model it started with, because Google signs each tool call
// for the model that made it.
async function callGemini(userId, messages, opts = {}) {
  const keys = _resolveKeys(userId);
  const limiter = _getLimiter(userId, keys.length);
  const models = opts.model && GEMINI_MODELS.includes(opts.model) ? [opts.model, ...GEMINI_MODELS.filter(m => m !== opts.model)] : GEMINI_MODELS;
  const once = opts.onText ? _streamOnce : _callOnce;

  return limiter.enqueue(async () => {
    let lastErr = null, tried = 0;
    for (const model of models) {
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (_cooling(key, model)) continue;
        tried++;
        try {
          const out = await once(model, key.apiKey, messages, opts);
          _record(key, { ok: true, model });
          if (out && typeof out === 'object') out.model = model;
          return out;
        } catch (err) {
          lastErr = err;
          if (_isQuotaError(err)) {
            _coolDown(key, model, err);
            _record(key, { error: err.response?.status === 503 ? 'Busy at Google; tried another' : 'Out of quota or rate-limited', model });
            logger.warn(`Gemini ${err.response?.status} on ${model} (key ${k + 1}/${keys.length}) — rotating`, { userId });
            continue;
          }
          // A refused key is the key's problem; a cut-off reply or a bad
          // request is not, and must not mark a working key as broken.
          if (_isAuthError(err)) _record(key, { error: 'Rejected by Google: the key is invalid or not enabled', model });
          throw err;
        }
      }
    }
    if (!tried) {
      // Every pair is cooling down: say so at once rather than queueing a
      // request that would only be refused.
      const err = new Error('Every LLM key is out of quota for the moment');
      err.response = { status: 429 };
      throw err;
    }
    throw lastErr;
  }, { interactive: !!opts.interactive });
}

// One turn of a conversation that may call tools: the same keys, models,
// rotation and company limiter as the reader, returning the model's whole
// message ({ content, tool_calls, truncated, model }) rather than its text.
// Asked as interactive, so it goes ahead of receipts being read.
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

function _reset() { _keyCache.clear(); _cool.clear(); _limiters.clear(); }

module.exports = { callGemini, chatWithTools, testGeminiKey, hasKeys, forgetKeys, GEMINI_MODELS, _reset, _cooling };
