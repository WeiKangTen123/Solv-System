import { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { setLoading(false); return; }
    api.get('/auth/me')
      .then(d => setUser(d.user))
      .catch(() => localStorage.removeItem('token'))
      .finally(() => setLoading(false));
  }, []);

  // Re-fetches /auth/me without a full page reload — used after Setup saves a
  // preference (like timezone) that other already-mounted components read off
  // the user object, so the change is reflected immediately everywhere.
  async function refreshUser() {
    if (!localStorage.getItem('token')) return;
    try { setUser((await api.get('/auth/me')).user); } catch { /* ignore */ }
  }

  // A 403 means the server no longer agrees with the role this page was built
  // for (an admin made a user while signed in): reload the account so the
  // admin tabs go. One reload at a time, however many calls were refused.
  useEffect(() => {
    let asking = false;
    const on = async () => {
      if (asking || !localStorage.getItem('token')) return;
      asking = true;
      try {
        const d = await api.get('/auth/me');
        // Signed out while this was asking: the answer is for nobody now.
        if (localStorage.getItem('token')) setUser(d.user);
      } catch { /* a 401 signs out on its own */ }
      finally { asking = false; }
    };
    window.addEventListener('solv:forbidden', on);
    return () => window.removeEventListener('solv:forbidden', on);
  }, []);

  async function login(email, password) {
    const data = await api.post('/auth/login', { email, password });
    localStorage.setItem('token', data.token);
    setUser(data.user);
    // The sign-in answer carries the account, not the company's currency and
    // time zone; until a reload every page showed SGD and Singapore time.
    await refreshUser();
    return data.user;
  }

  // The page forgets the session first and tells the server after. It used to
  // wait for the server, and the sign-out button went to /login meanwhile:
  // still signed in, /login sent it on to Home, which mounted and fired its
  // loads with a token the server was just revoking, then bounced to /login.
  // The server is still told, so it ends the session everywhere and stops
  // this account's mailbox watcher. Best-effort: a failed request must never
  // trap the user in a session they asked to leave.
  async function logout() {
    const token = localStorage.getItem('token');
    localStorage.removeItem('token');
    setUser(null);
    if (!token) return;
    try { await api.post('/auth/logout', {}, { Authorization: `Bearer ${token}` }); } catch (_) { /* leaving anyway */ }
  }

  async function register(email, password, name) {
    const data = await api.post('/auth/register', { email, password, name });
    localStorage.setItem('token', data.token);
    setUser(data.user);
    await refreshUser();
    return data.user;
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, register, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
