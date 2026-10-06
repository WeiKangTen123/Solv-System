import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useViewMode } from '../../context/ViewModeContext';
import { formatDateTime } from '../../utils/formatDate';

// The assistant, on every page. It reads, checks and analyses through the
// server's tools, and anything it would change arrives as a card the person
// applies or dismisses. Conversations are the person's own; the server has no
// route that shows one to anybody else.
//
// The open state and the conversation in progress are remembered per browser,
// so moving between pages keeps the thread.

const KEY = 'solv.assistant';
const remember = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } };
const recall = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };

function suggestionsFor(path, isAdmin) {
  if (/^\/expenses\/[^/]+$/.test(path)) return ['Check this receipt for problems', 'Does it match what is printed on the receipt?', 'Explain the exchange rate on this one'];
  if (/^\/reports\/[^/]+/.test(path)) return ['Is this case ready to claim?', 'Which receipts in this case need attention?', 'Summarise this case by category'];
  return [
    'What needs my attention?',
    'Summarise my spending this month by category',
    isAdmin ? 'Which receipts across the company need attention?' : 'Which receipts are not in a case yet?',
  ];
}

// A little Markdown, made of React elements: paragraphs, "- " bullets
// (indented ones nest a step), **bold** and `code`. Nothing is ever set as
// HTML, so text from a receipt can never become markup.
function inline(text) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    parts.push(t.startsWith('**') ? <strong key={k++}>{t.slice(2, -2)}</strong> : <code key={k++} className="assistant-code">{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
function Rich({ text }) {
  const blocks = [];
  let list = null;
  String(text || '').split('\n').forEach((raw, i) => {
    const bullet = raw.match(/^(\s*)[-*•]\s+(.*)$/);
    if (bullet) {
      if (!list) { list = []; blocks.push({ list }); }
      list.push({ depth: Math.min(2, Math.floor(bullet[1].length / 2)), text: bullet[2], i });
      return;
    }
    list = null;
    if (raw.trim()) blocks.push({ p: raw.trim(), i });
  });
  return blocks.map((b, j) => (b.list
    ? <ul key={j} className="assistant-list">{b.list.map(it => <li key={it.i} style={{ marginLeft: it.depth * 14 }}>{inline(it.text)}</li>)}</ul>
    : <p key={j} className="assistant-p">{inline(b.p)}</p>));
}

const STATUS = { applied: 'Applied', dismissed: 'Dismissed', failed: 'Not applied' };

function ActionCard({ action, onApply, onDismiss, busy }) {
  const pending = action.status === 'pending';
  return (
    <div className={`assistant-card assistant-card-${action.status}`}>
      <div className="assistant-card-summary">{action.summary}</div>
      {action.payload?.reason && <div className="assistant-card-reason">{action.payload.reason}</div>}
      {pending ? (
        <div className="assistant-card-buttons">
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onApply(action)}>{busy ? 'Applying…' : 'Apply'}</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onDismiss(action)}>Dismiss</button>
        </div>
      ) : (
        <div className="assistant-card-status">
          {STATUS[action.status] || action.status}{action.status === 'failed' && action.result ? `: ${action.result}` : ''}
        </div>
      )}
    </div>
  );
}

export default function AssistantPanel() {
  const { user } = useAuth();
  const { isMobile } = useViewMode();
  const location = useLocation();
  const saved = useRef(recall());
  const [open, setOpen] = useState(!!saved.current.open);
  const [conversationId, setConversationId] = useState(saved.current.conversationId || null);
  const [messages, setMessages] = useState([]);
  const [actions, setActions] = useState([]);
  const [view, setView] = useState('chat');            // chat | history
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [applying, setApplying] = useState({});
  const [error, setError] = useState(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { remember({ open, conversationId }); }, [open, conversationId]);

  const loadConversation = useCallback(async id => {
    if (!id) { setMessages([]); setActions([]); return; }
    try {
      const d = await api.get(`/assistant/conversations/${id}`);
      setMessages(d.messages); setActions(d.actions);
    } catch {
      // Gone, or someone else's after a change of account: start afresh.
      setConversationId(null); setMessages([]); setActions([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    api.get('/assistant/status').then(setStatus).catch(() => {});
    loadConversation(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => { if (open && view === 'chat') endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, actions, thinking, open, view]);
  useEffect(() => { if (open && view === 'chat') inputRef.current?.focus(); }, [open, view]);

  async function send(text) {
    const message = String(text ?? draft).trim();
    if (!message || thinking) return;
    setError(null); setThinking(true);
    const optimistic = { id: `tmp-${Date.now()}`, role: 'user', content: message, createdAt: new Date().toISOString() };
    setMessages(ms => [...ms, optimistic]);
    setDraft('');
    try {
      const d = await api.post('/assistant/chat', { message, conversationId, page: location.pathname });
      if (!conversationId) setConversationId(d.conversation.id);
      setMessages(ms => [...ms.filter(m => m.id !== optimistic.id), { ...optimistic, id: `u-${d.message.id}` }, d.message]);
      setActions(as => [...as, ...d.actions]);
      if (d.usage) setStatus(s => ({ ...(s || {}), ...d.usage }));
    } catch (e) {
      setMessages(ms => ms.filter(m => m.id !== optimistic.id));
      setDraft(message);
      setError(e.message);
    } finally { setThinking(false); }
  }

  const replace = a => setActions(as => as.map(x => (x.id === a.id ? a : x)));
  async function apply(a) {
    setApplying(s => ({ ...s, [a.id]: true }));
    try {
      const d = await api.post(`/assistant/actions/${a.id}/apply`, {});
      replace(d.action);
      if (d.action.status === 'applied') window.dispatchEvent(new CustomEvent('solv:changed', { detail: { expenseId: d.action.expenseId } }));
    } catch (e) { setError(e.message); }
    finally { setApplying(s => ({ ...s, [a.id]: false })); }
  }
  async function applyAll(list) { for (const a of list) await apply(a); }
  async function dismiss(a) {
    try { replace((await api.post(`/assistant/actions/${a.id}/dismiss`, {})).action); }
    catch (e) { setError(e.message); }
  }

  function newChat() { setConversationId(null); setMessages([]); setActions([]); setError(null); setView('chat'); }
  async function showHistory() {
    setView('history');
    try { setHistory((await api.get('/assistant/conversations')).conversations); } catch (e) { setError(e.message); }
  }
  async function openConversation(id) { setConversationId(id); setView('chat'); setError(null); await loadConversation(id); }
  async function removeConversation(id) {
    try {
      await api.delete(`/assistant/conversations/${id}`);
      setHistory(h => h.filter(c => c.id !== id));
      if (id === conversationId) newChat();
    } catch (e) { setError(e.message); }
  }

  if (!user) return null;
  if (!open) {
    return (
      <button className="assistant-fab" style={isMobile ? { bottom: 'calc(var(--bottom-nav-total) + 14px)' } : undefined}
              onClick={() => setOpen(true)} aria-label="Open the assistant" title="Ask the assistant">
        <span aria-hidden="true">✦</span> Ask
      </button>
    );
  }

  const byMessage = new Map();
  for (const a of actions) { const k = a.messageId || 'none'; if (!byMessage.has(k)) byMessage.set(k, []); byMessage.get(k).push(a); }
  const unavailable = status && status.available === false;
  const low = status && status.remaining !== undefined && status.remaining <= 10;

  return (
    <div className={`assistant-panel ${isMobile ? 'assistant-panel-mobile' : ''}`} role="dialog" aria-label="Assistant">
      <div className="assistant-head">
        <div className="assistant-title"><span aria-hidden="true">✦</span> Assistant</div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn-ghost btn-sm" onClick={view === 'history' ? () => setView('chat') : showHistory}>{view === 'history' ? 'Back' : 'History'}</button>
          <button className="btn btn-ghost btn-sm" onClick={newChat} disabled={thinking}>New</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Close the assistant">✕</button>
        </div>
      </div>

      {view === 'history' ? (
        <div className="assistant-body">
          {!history.length && <div className="assistant-muted">No conversations yet.</div>}
          {history.map(c => (
            <div key={c.id} className="assistant-history-row">
              <button className="assistant-history-open" onClick={() => openConversation(c.id)}>
                <div className="assistant-history-title">{c.title || 'Conversation'}</div>
                <div className="assistant-muted">{formatDateTime(c.updatedAt, user?.timezone)}</div>
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => removeConversation(c.id)} aria-label="Delete this conversation" title="Delete">✕</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="assistant-body">
          {!messages.length && (
            <div className="assistant-welcome">
              <p className="assistant-p">I can check your receipts, compare them with the paper, explain rates and summarise spending. I can propose corrections too. Nothing changes until you press <strong>Apply</strong>.</p>
              {unavailable
                ? <div className="alert alert-warning" style={{ marginBottom: 0 }}>The assistant needs an LLM key. {user.role === 'admin' ? 'Add one in Settings, under LLM API Setup.' : 'Ask an admin to add one in Settings.'}</div>
                : suggestionsFor(location.pathname, user.role === 'admin').map(s => (
                  <button key={s} className="assistant-suggestion" onClick={() => send(s)} disabled={thinking}>{s}</button>
                ))}
            </div>
          )}
          {messages.map(m => {
            const cards = m.role === 'assistant' ? (byMessage.get(m.id) || []) : [];
            const pending = cards.filter(a => a.status === 'pending');
            return (
              <div key={m.id} className={`assistant-msg assistant-msg-${m.role}`}>
                <div className="assistant-bubble">{m.role === 'assistant' ? <Rich text={m.content} /> : m.content}</div>
                {cards.map(a => <ActionCard key={a.id} action={a} onApply={apply} onDismiss={dismiss} busy={!!applying[a.id]} />)}
                {pending.length > 1 && (
                  <button className="btn btn-outline btn-sm" style={{ alignSelf: 'flex-start' }} disabled={pending.some(a => applying[a.id])} onClick={() => applyAll(pending)}>
                    Apply all {pending.length}
                  </button>
                )}
              </div>
            );
          })}
          {thinking && <div className="assistant-msg assistant-msg-assistant"><div className="assistant-bubble assistant-muted">Working on it…</div></div>}
          <div ref={endRef} />
        </div>
      )}

      {error && <div className="alert alert-error assistant-error">{error}</div>}

      {view === 'chat' && (
        <form className="assistant-input" onSubmit={e => { e.preventDefault(); send(); }}>
          <textarea ref={inputRef} className="form-input" rows={2} maxLength={4000} value={draft} disabled={unavailable}
                    placeholder={unavailable ? 'Unavailable until an LLM key is added' : 'Ask about your receipts…'}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <button className="btn btn-primary" type="submit" disabled={thinking || !draft.trim() || unavailable}>Send</button>
        </form>
      )}
      <div className="assistant-foot">
        Private to you. Changes happen only when you press Apply.{low ? ` ${status.remaining} question${status.remaining === 1 ? '' : 's'} left this hour.` : ''}
      </div>
    </div>
  );
}
