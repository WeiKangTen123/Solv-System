const crypto = require('crypto');
const db = require('../db');

// The assistant's records. A conversation belongs to the person who had it and
// to nobody else: every read here takes the user id and filters on it, so a
// route cannot hand one person's conversation to another, admins included.

const now = () => new Date().toISOString();
const newId = () => `${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;

// ── Conversations ────────────────────────────────────────────────────────────

function createConversation(userId, title) {
  const id = newId(), at = now();
  db.prepare('INSERT INTO assistant_conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, title ? String(title).slice(0, 80) : null, at, at);
  return getConversation(id, userId);
}
function getConversation(id, userId) {
  const r = db.prepare('SELECT * FROM assistant_conversations WHERE id = ? AND user_id = ?').get(id, userId);
  return r ? { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } : null;
}
function listConversations(userId, limit = 30) {
  return db.prepare('SELECT * FROM assistant_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?').all(userId, limit)
    .map(r => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
}
function deleteConversation(id, userId) {
  return db.prepare('DELETE FROM assistant_conversations WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
function _touch(id) { db.prepare('UPDATE assistant_conversations SET updated_at = ? WHERE id = ?').run(now(), id); }

// ── Messages ─────────────────────────────────────────────────────────────────

function addMessage(conversationId, role, content) {
  const info = db.prepare('INSERT INTO assistant_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(conversationId, role, String(content), now());
  _touch(conversationId);
  return Number(info.lastInsertRowid);
}
// The last `limit` messages, oldest first.
function messages(conversationId, limit = 200) {
  return db.prepare('SELECT * FROM (SELECT * FROM assistant_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
    .all(conversationId, limit)
    .map(r => ({ id: r.id, role: r.role, content: r.content, createdAt: r.created_at }));
}

// ── Proposed changes ─────────────────────────────────────────────────────────

function _action(r) {
  if (!r) return null;
  let payload = null; try { payload = JSON.parse(r.payload); } catch { payload = null; }
  return { id: r.id, conversationId: r.conversation_id, messageId: r.message_id, userId: r.user_id, expenseId: r.expense_id,
           kind: r.kind, payload, summary: r.summary, status: r.status, result: r.result, createdAt: r.created_at, decidedAt: r.decided_at };
}
function addAction({ conversationId, userId, expenseId = null, kind, payload, summary }) {
  const id = newId();
  db.prepare(`INSERT INTO assistant_actions (id, conversation_id, user_id, expense_id, kind, payload, summary, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, conversationId, userId, expenseId, kind, JSON.stringify(payload), String(summary).slice(0, 1000), now());
  return getAction(id, userId);
}
function attachActions(ids, messageId) {
  const upd = db.prepare('UPDATE assistant_actions SET message_id = ? WHERE id = ?');
  for (const id of ids) upd.run(messageId, id);
}
function getAction(id, userId) {
  return _action(db.prepare('SELECT * FROM assistant_actions WHERE id = ? AND user_id = ?').get(id, userId));
}
function actionsFor(conversationId) {
  return db.prepare('SELECT * FROM assistant_actions WHERE conversation_id = ? ORDER BY created_at, id').all(conversationId).map(_action);
}
// Moves a pending action on, once: two clicks on Apply cannot both win.
function decideAction(id, userId, status, result = null) {
  return db.prepare("UPDATE assistant_actions SET status = ?, result = ?, decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'")
    .run(status, result ? String(result).slice(0, 500) : null, now(), id, userId).changes > 0;
}
function claimAction(id, userId) {
  // 'pending' → 'pending' with decided_at set marks it as being applied, so a
  // second Apply arriving while the first runs is turned away.
  return db.prepare("UPDATE assistant_actions SET decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND decided_at IS NULL")
    .run(now(), id, userId).changes > 0;
}
function releaseAction(id, userId) {
  db.prepare("UPDATE assistant_actions SET decided_at = NULL WHERE id = ? AND user_id = ? AND status = 'pending'").run(id, userId);
}

// ── Usage ────────────────────────────────────────────────────────────────────

function recordQuestion(userId) { db.prepare('INSERT INTO assistant_usage (user_id, at) VALUES (?, ?)').run(userId, now()); }
function questionsSince(userId, sinceIso) {
  return db.prepare('SELECT COUNT(*) AS n FROM assistant_usage WHERE user_id = ? AND at >= ?').get(userId, sinceIso).n;
}
// When the oldest question in the window leaves it, as an ISO time.
function oldestSince(userId, sinceIso) {
  const r = db.prepare('SELECT MIN(at) AS at FROM assistant_usage WHERE user_id = ? AND at >= ?').get(userId, sinceIso);
  return r ? r.at : null;
}
function pruneUsage(beforeIso) { db.prepare('DELETE FROM assistant_usage WHERE at < ?').run(beforeIso); }

module.exports = {
  createConversation, getConversation, listConversations, deleteConversation,
  addMessage, messages,
  addAction, attachActions, getAction, actionsFor, decideAction, claimAction, releaseAction,
  recordQuestion, questionsSince, oldestSince, pruneUsage,
};
