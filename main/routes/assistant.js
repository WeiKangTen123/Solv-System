const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const astore  = require('../assistant/store');
const conversation = require('../assistant/conversation');
const actions = require('../assistant/actions');
const logger  = require('../utils/logger');

// The assistant. Every route works on the signed-in person's own
// conversations; there is no route, admin or otherwise, that reads anybody
// else's. Questions are limited per person per hour, and one is answered at
// a time.

const PER_HOUR = Number(process.env.ASSISTANT_PER_HOUR) || 60;
const HOUR = 60 * 60 * 1000;
const _busy = new Set();

function _keysConfigured(userId) {
  try {
    if (require('../store/users').getGeminiKeysForUser(userId).length) return true;
  } catch { /* fall through to the server's own key */ }
  return !!process.env.Gemini_API_KEY;
}
function _usage(userId) {
  const since = new Date(Date.now() - HOUR).toISOString();
  const used = astore.questionsSince(userId, since);
  const oldest = used ? astore.oldestSince(userId, since) : null;
  return { limit: PER_HOUR, used, remaining: Math.max(0, PER_HOUR - used), resetsAt: oldest ? new Date(Date.parse(oldest) + HOUR).toISOString() : null };
}

router.get('/status', requireAuth, (req, res) => {
  res.json({ available: _keysConfigured(req.user.id), ...(_usage(req.user.id)) });
});

router.get('/conversations', requireAuth, (req, res) => {
  res.json({ conversations: astore.listConversations(req.user.id) });
});

router.get('/conversations/:id', requireAuth, (req, res) => {
  const c = astore.getConversation(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ conversation: c, messages: astore.messages(c.id), actions: astore.actionsFor(c.id) });
});

router.delete('/conversations/:id', requireAuth, (req, res) => {
  if (!astore.deleteConversation(req.params.id, req.user.id)) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ ok: true });
});

router.post('/chat', requireAuth, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (typeof b.message !== 'string') return res.status(400).json({ error: 'Send a message' });
  if (b.conversationId !== undefined && b.conversationId !== null && typeof b.conversationId !== 'string') return res.status(400).json({ error: 'Bad conversation' });
  if (!_keysConfigured(req.user.id)) return res.status(503).json({ error: 'The assistant needs an LLM key. An admin can add one in Settings, under LLM API Setup.' });
  const usage = _usage(req.user.id);
  if (usage.remaining <= 0) {
    return res.status(429).json({ error: `That is ${PER_HOUR} questions this hour, the most the assistant answers per person. It can take more after ${new Date(usage.resetsAt).toISOString().slice(11, 16)} UTC.`, ...usage });
  }
  if (_busy.has(req.user.id)) return res.status(429).json({ error: 'Still answering your last question.' });
  _busy.add(req.user.id);
  astore.recordQuestion(req.user.id);
  try {
    const out = await conversation.reply({ actor: req.user, conversationId: b.conversationId || null, text: b.message, page: typeof b.page === 'string' ? b.page.slice(0, 200) : null });
    res.json({ ...out, usage: _usage(req.user.id) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    const status = err.response && err.response.status;
    logger.warn('Assistant failed to answer', { userId: req.user.id, status, error: err.message });
    if (status === 429 || status === 503) return res.status(503).json({ error: 'The LLM keys are out of quota or busy right now. Try again in a minute.' });
    if (status === 401 || status === 403) return res.status(503).json({ error: 'The LLM key was refused. An admin can check it in Settings, under LLM API Setup.' });
    if (/No Gemini API key/.test(err.message)) return res.status(503).json({ error: 'The assistant needs an LLM key. An admin can add one in Settings, under LLM API Setup.' });
    res.status(502).json({ error: 'The assistant could not answer just now. Try again.' });
  } finally {
    _busy.delete(req.user.id);
  }
}));

router.post('/actions/:id/apply', requireAuth, asyncHandler(async (req, res) => {
  try { res.json({ action: await actions.apply(req.params.id, req.user) }); }
  catch (err) { if (!err.status) throw err; res.status(err.status).json({ error: err.message }); }
}));

router.post('/actions/:id/dismiss', requireAuth, (req, res) => {
  try { res.json({ action: actions.dismiss(req.params.id, req.user) }); }
  catch (err) { if (!err.status) throw err; res.status(err.status).json({ error: err.message }); }
});

// Usage rows only feed the hourly limit and a thirty-day count; older ones go.
function pruneUsage() { try { astore.pruneUsage(new Date(Date.now() - 31 * 24 * HOUR).toISOString()); } catch { /* next time */ } }

module.exports = router;
module.exports.pruneUsage = pruneUsage;
module.exports.PER_HOUR = PER_HOUR;
