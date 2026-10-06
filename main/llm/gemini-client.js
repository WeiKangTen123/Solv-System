const axios  = require('axios');
const logger = require('../utils/logger');

// Gemini-only — Nvidia/OpenRouter were removed. Both models below are called through
// the same OpenAI-compatible endpoint; only the `model` field differs, so rotating
// between them on a quota error is a same-shape retry, not a provider switch.
const GEMINI_URL    = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

// Keys are company-wide: the company's keys in rotation order, then the .env
// fallback. The limiter below is keyed by company too, because the quota is
// the key's, not the user's.
function _resolveKeys(userId) {
  const keys = [];
  if (userId) {
    const { getGeminiKeysForUser } = require('../store/users');
    for (const row of getGeminiKeysForUser(userId)) keys.push({ apiKey: row.apiKey, id: row.id ?? null, scope: row.scope || null });
  }
  if (!keys.length && process.env.Gemini_API_KEY) keys.push({ apiKey: process.env.Gemini_API_KEY, id: null, scope: 'env' });
  if (!keys.length) throw new Error('No Gemini API key configured — add one in Settings');
  return keys;
}

// What happened to a stored key, written back to it for Settings to show.
// The server's own fallback key has no row. Never allowed to fail a read.
function _record(key, result) {
  if (!key || !key.id || !key.scope || key.scope === 'env') return;
  try {
    const users = require('../store/users');
    if (typeof users.recordKeyUse === 'function') users.recordKeyUse(key.scope, key.id, result);
  } catch { /* status is a convenience */ }
}
const _isAuthError = err => [401, 403].includes(err.response?.status);
function _limiterKey(userId) {
  if (!userId) return 'default';
  try { const u = require('../store/users').findById(userId); return u ? `company:${u.companyId}` : String(userId); }
  catch { return String(userId); }
}

function _isQuotaError(err) {
  const status = err.response?.status;
  return status === 429 || status === 503;
}

// ── Per-user rate limiter (15 RPM sliding window, 5 concurrent) ───────────────
// Shared across both models — conservative default matching each model's own cap.

const RPM           = 15;
const RPM_WINDOW_MS = 60_000;
const MAX_CONCURRENT = 5;

class UserRateLimiter {
  constructor(rpm, windowMs, maxConcurrent) {
    this.rpm = rpm;
    this.windowMs = windowMs;
    this.maxConcurrent = maxConcurrent;
    this.timestamps = [];
    this.queue = [];
    this.running = 0;
    this._drainTimer = null;
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
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
function _getLimiter(userId) {
  const key = _limiterKey(userId);
  if (!_limiters.has(key)) _limiters.set(key, new UserRateLimiter(RPM, RPM_WINDOW_MS, MAX_CONCURRENT));
  return _limiters.get(key);
}

// ── Core call, with model rotation on quota errors ───────────────────────────

async function _callOnce(model, key, messages, opts) {
  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens:  opts.maxTokens ?? 800,
  };
  if (opts.tools) { body.tools = opts.tools; body.tool_choice = 'auto'; }
  const response = await axios.post(GEMINI_URL, body, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: opts.timeoutMs ?? 120_000,
  });
  const choice = response.data.choices?.[0];
  // With tools, the whole message is the answer: it may be tool calls and no
  // text. Each tool call carries Google's thought signature, which has to go
  // back verbatim with the call or the next request is refused.
  if (opts.tools) {
    if (!choice?.message || (!choice.message.content && !(choice.message.tool_calls || []).length)) throw new Error(`Gemini returned empty response (model: ${model})`);
    return choice.message;
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

// Two-level rotation: for the current key, try every model in GEMINI_MODELS order;
// only once ALL models are exhausted (quota/rate-limited) on that key does it move
// to the next key. No backoff wait between attempts — a different model or key has
// its own separate quota, so waiting on the exhausted one first is pointless. Any
// non-quota error (bad request, auth failure) fails fast instead of burning through
// every remaining model/key on a request that will fail the exact same way there too.
async function callGemini(userId, messages, opts = {}) {
  const keys = _resolveKeys(userId);
  const limiter = _getLimiter(userId);

  return limiter.enqueue(async () => {
    let lastErr;
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      for (const model of GEMINI_MODELS) {
        try {
          const out = await _callOnce(model, key.apiKey, messages, opts);
          _record(key, { ok: true, model });
          return out;
        } catch (err) {
          lastErr = err;
          if (_isQuotaError(err)) {
            _record(key, { error: 'Out of quota or rate-limited', model });
            logger.warn(`Gemini quota/rate limit on ${model} (key ${k + 1}/${keys.length}) — rotating`, { userId });
            continue;
          }
          // A refused key is the key's problem; a cut-off reply or a bad
          // request is not, and must not mark a working key as broken.
          if (_isAuthError(err)) _record(key, { error: 'Rejected by Google: the key is invalid or not enabled', model });
          throw err;
        }
      }
      if (k < keys.length - 1) {
        logger.warn(`All models exhausted on key ${k + 1}/${keys.length} — moving to next key`, { userId });
      }
    }
    throw lastErr;
  });
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
        {
          model,
          messages: [{ role: 'user', content: 'Ping' }],
          max_tokens: 5,
        },
        {
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          timeout: 15_000,
        }
      );
      if (response.data?.choices?.[0]?.message) {
        // latencyMs: the Profile screen has always printed it, and it read
        // "undefinedms" because it was never returned.
        return { ok: true, model, latencyMs: Date.now() - t0 };
      }
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        throw new Error('Invalid Gemini API key. Please check the key from Google AI Studio.');
      }
      if (status === 429) {
        throw new Error('Gemini API key quota exceeded or rate limited.');
      }
    }
  }
  const msg = lastErr?.response?.data?.error?.message || lastErr?.message || 'Could not verify Gemini API key';
  throw new Error(`Gemini test failed: ${msg}`);
}

// One turn of a conversation that may call tools: the same keys, models,
// rotation and company limiter as the reader, returning the model's whole
// message ({ content, tool_calls }) rather than its text.
function chatWithTools(userId, messages, tools, opts = {}) {
  return callGemini(userId, messages, { ...opts, tools });
}

module.exports = { callGemini, chatWithTools, GEMINI_MODELS, testGeminiKey };
