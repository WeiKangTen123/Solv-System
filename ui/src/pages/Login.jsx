import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import AuthShell from '../components/auth/AuthShell';
import { PasswordField, SubmitButton, SwitchLink } from '../components/auth/fields';

// Signing in. Creating an account is its own page now (Signup.jsx), linked
// below the card, rather than a tab that appeared only when an admin had
// switched registration on — which in practice was never.
export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [shaking, setShaking]   = useState(false);
  const shakeTimer = useRef(null);

  // A brand-new system has nobody to sign in as: its first account, the
  // administrator's, is made on the sign-up page.
  useEffect(() => {
    api.get('/auth/status')
      .then(d => { if (!d.hasUsers) navigate('/signup', { replace: true }); })
      .catch(() => {});
    return () => clearTimeout(shakeTimer.current);
  }, [navigate]);

  function triggerError(msg) {
    setError(msg);
    setShaking(true);
    clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => setShaking(false), 600);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      // Locked out after too many wrong passwords. Waiting is not the only way
      // back: an admin can set a new password.
      const locked = err.status === 429 && !/administrator/i.test(err.message);
      triggerError(locked ? `${err.message.replace(/\.\s*$/, '')}, or ask your administrator.` : err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      subtitle="Welcome back, sign in to continue"
      shaking={shaking}
      below={<SwitchLink prompt="New to Solv?" to="/signup">Create an account →</SwitchLink>}
    >
      {error && (
        <div className="alert alert-error" role="alert">
          <span className="alert-icon">✕</span>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="form-group" style={{ animation: 'fadeUp 0.3s ease 0ms both' }}>
          <label htmlFor="login-email" className="form-label">Email address</label>
          <div className="input-wrapper">
            {/* autocomplete lets a password manager fill the right box. */}
            <input id="login-email"
              type="email"
              className="form-input has-icon"
              placeholder="you@company.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="username"
            />
            <span className="input-icon" style={{ left: 12, top: '50%', transform: 'translateY(-50%)', position: 'absolute', color: 'var(--text-muted)', fontSize: 15 }}>✉</span>
          </div>
        </div>

        <PasswordField
          id="login-password" label="Password" value={password} onChange={setPassword}
          show={showPass} onToggleShow={() => setShowPass(v => !v)}
          placeholder="Enter your password" autoComplete="current-password" minLength={1}
          style={{ marginBottom: 22, animation: 'fadeUp 0.3s ease 60ms both' }}
        />

        <div style={{ animation: 'fadeUp 0.3s ease 110ms both' }}>
          <SubmitButton loading={loading}>Sign in</SubmitButton>
        </div>
      </form>
    </AuthShell>
  );
}
