const BASE = '/api';

function getToken() {
  return localStorage.getItem('token');
}

function clearSession() {
  localStorage.removeItem('token');
  // Hard-navigate to login so all React state is wiped — avoids stale UI
  // showing for a split second after an expired-token 401.
  // Phone capture pages (/capture/:token) are deliberately unauthenticated and must never redirect to login.
  const path = window.location.pathname;
  if (!path.startsWith('/login') && !path.startsWith('/capture')) {
    window.location.href = '/login';
  }
}

async function request(path, options = {}) {
  const token   = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res  = await fetch(`${BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 401) clearSession();
    // Refused for who you are. The role is checked live on the server, so an
    // admin made a user since the page loaded kept seeing admin tabs that
    // answered nothing but 403; AuthContext reloads the account on this and
    // the screen drops to what the account may now do.
    if (res.status === 403) window.dispatchEvent(new CustomEvent('solv:forbidden'));
    // A 401 throws too. On most pages the navigation above wins the race and
    // the caller never runs; on /login (no navigation) a wrong password used to
    // come back as `undefined` and blow up as "cannot read 'token'" instead of
    // the server's own message.
    const err    = new Error(data.error || (res.status === 401 ? 'Your session has expired. Sign in again.' : `HTTP ${res.status}`));
    err.status   = res.status;
    throw err;
  }
  return data;
}

// A POST whose answer is a stream of server-sent events (the assistant). Each
// event's JSON is handed to onEvent as it arrives. Errors before the stream
// opens throw like any other call.
export async function streamPost(path, body, onEvent) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) clearSession();
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // Events end at a blank line. A proxy may turn line endings into \r\n, and
  // the last event can arrive without its blank line when the stream closes.
  const events = final => {
    buf = buf.replace(/\r\n/g, '\n');
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0 || (final && buf)) {
      const chunk = cut >= 0 ? buf.slice(0, cut) : buf;
      buf = cut >= 0 ? buf.slice(cut + 2) : '';
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;   // ': keep-alive' and other comments
        try { onEvent(JSON.parse(line.slice(5))); } catch { /* not an event of ours */ }
      }
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    events(false);
  }
  buf += decoder.decode();
  events(true);
}

export const api = {
  get:    (path)       => request(path),
  // `headers` is for the one call that must name its own session: signing out
  // sends the token it is ending after the page has already forgotten it.
  post:   (path, body, headers) => request(path, { method: 'POST', body: JSON.stringify(body), headers }),
  // PUT is only used to replace an expense's lines, but leaving it out broke
  // that one call with "api.put is not a function" — and because Mark reviewed,
  // Refresh rate and Change rate all save first, the whole review step died
  // with it. The route check in main/scripts/ui-api-paths.test.js confirmed the
  // path existed on the server and never noticed the verb was missing here.
  put:    (path, body) => request(path, { method: 'PUT',    body: JSON.stringify(body) }),
  patch:  (path, body) => request(path, { method: 'PATCH',  body: JSON.stringify(body) }),
  delete: (path)       => request(path, { method: 'DELETE' }),
};
