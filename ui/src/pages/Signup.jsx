import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import AuthShell from '../components/auth/AuthShell';
import { PasswordField, SubmitButton, SwitchLink } from '../components/auth/fields';

// Creating an account, like any login system: anyone may, and is signed in at
// once. The very first account on a new system becomes the administrator and
// creates the company; everyone after joins it as a user, and an admin can
// change a person's role in Users & Monitoring.
//
// The checks here are the server's own (routes/auth.js), asked before the
// request so a mistyped confirmation is caught without a round trip; the
// server still decides.
const MIN_PASSWORD = 8;

export default function Signup() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [firstRun, setFirstRun] = useState(false);
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [shaking, setShaking]   = useState(false);
  const shakeTimer = useRef(null);

  useEffect(() => {
    api.get('/auth/status').then(d => setFirstRun(!d.hasUsers)).catch(() => {});
    return () => clearTimeout(shakeTimer.current);
  }, []);

  function triggerError(msg) {
    setError(msg);
    setShaking(true);
    clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => setShaking(false), 600);
  }

  // What is wrong with the form as typed, or null.
  function problem() {
    if (!name.trim()) return 'Type your name.';
    if (password.length < MIN_PASSWORD) return `The password needs at least ${MIN_PASSWORD} characters.`;
    if (!password.trim()) return 'A password cannot be only spaces.';
    if (password !== confirm) return 'The two passwords are not the same.';
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const wrong = problem();
    if (wrong) { triggerError(wrong); return; }
    setLoading(true);
    try {
      await register(email.trim(), password, name.trim());
      navigate('/');
    } catch (err) {
      triggerError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <AuthShell
      subtitle={firstRun ? 'Create the administrator account and your company' : 'Create your account'}
      shaking={shaking}
      below={!firstRun && <SwitchLink prompt="Already have an account?" to="/login">Sign in →</SwitchLink>}
    >
      {error && (
        <div className="alert alert-error" role="alert">
          <span className="alert-icon">✕</span>
          {error}
        </div>
      )}
      {firstRun && !error && (
        <div className="alert alert-info" style={{ marginBottom: 20 }}>
          <span className="alert-icon">ℹ</span>
          The first account becomes the administrator and creates the company.
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div className="form-group" style={{ animation: 'fadeUp 0.3s ease 0ms both' }}>
          <label htmlFor="signup-name" className="form-label">Full name</label>
          <input id="signup-name"
            className="form-input"
            placeholder="Jane Tan"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            maxLength={120}
            autoFocus
            autoComplete="name"
          />
        </div>

        <div className="form-group" style={{ animation: 'fadeUp 0.3s ease 30ms both' }}>
          <label htmlFor="signup-email" className="form-label">Email address</label>
          <div className="input-wrapper">
            <input id="signup-email"
              type="email"
              className="form-input has-icon"
              placeholder="you@company.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
            <span className="input-icon" style={{ left: 12, top: '50%', transform: 'translateY(-50%)', position: 'absolute', color: 'var(--text-muted)', fontSize: 15 }}>✉</span>
          </div>
        </div>

        <PasswordField
          id="signup-password" label="Password" value={password} onChange={setPassword}
          show={showPass} onToggleShow={() => setShowPass(v => !v)}
          placeholder={`At least ${MIN_PASSWORD} characters`} autoComplete="new-password" minLength={MIN_PASSWORD}
          describedBy="signup-password-hint"
          style={{ marginBottom: 12, animation: 'fadeUp 0.3s ease 60ms both' }}
        />
        <PasswordField
          id="signup-confirm" label="Confirm password" value={confirm} onChange={setConfirm}
          show={showPass}
          placeholder="Type it again" autoComplete="new-password" minLength={MIN_PASSWORD}
          describedBy="signup-password-hint"
          style={{ marginBottom: 6, animation: 'fadeUp 0.3s ease 80ms both' }}
        />
        <div id="signup-password-hint" style={{ fontSize: 12, color: mismatch ? 'var(--danger)' : 'var(--text-muted)', marginBottom: 20 }}>
          {mismatch ? 'The two passwords are not the same yet.' : `At least ${MIN_PASSWORD} characters.`}
        </div>

        <div style={{ animation: 'fadeUp 0.3s ease 110ms both' }}>
          <SubmitButton loading={loading}>Create account</SubmitButton>
        </div>
      </form>
    </AuthShell>
  );
}
