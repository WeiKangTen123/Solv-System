import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { api } from '../api/client';

// Every colour here comes from the palette. This page used to carry fourteen
// hex values of its own, inherited from the app it was ported from, so it was
// the one screen that did not change when the theme did — you signed in to one
// product and landed in another.
export default function Login() {
  const { login, register } = useAuth();
  const { theme, toggle }   = useTheme();
  const navigate = useNavigate();

  const [mode, setMode]       = useState('login');
  const [firstRun, setFirstRun] = useState(false);
  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [tabKey, setTabKey]   = useState(0);
  const [slideDir, setSlideDir] = useState('right');

  const shakeTimer = useRef(null);

  useEffect(() => {
    api.get('/auth/status')
      .then(d => { if (!d.hasUsers) { setFirstRun(true); setMode('register'); } })
      .catch(() => {});
    return () => clearTimeout(shakeTimer.current);
  }, []);

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
      if (mode === 'login') await login(email, password);
      else                  await register(email, password);
      navigate('/');
    } catch (err) {
      triggerError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function switchMode(m) {
    if (m === mode) return;
    setSlideDir(m === 'register' ? 'left' : 'right');
    setMode(m);
    setTabKey(k => k + 1);
    setError('');
    setEmail('');
    setPassword('');
    setShowPass(false);
  }

  const isDark = theme === 'dark';

  // The drifting fields behind the card are ink on paper and light on ink:
  // no hue, because the theme has no brand colour to spend here. They give the
  // ground some depth without putting a colour on a page whose whole idea is
  // that colour means a status.
  const orb = isDark
    ? ['rgba(240,246,252,0.075)', 'rgba(240,246,252,0.05)', 'rgba(240,246,252,0.035)']
    : ['rgba(13,17,23,0.055)',    'rgba(13,17,23,0.040)',   'rgba(13,17,23,0.028)'];

  return (
    <div style={{ position: 'relative', minHeight: '100vh', display: 'flex', overflow: 'hidden', background: 'var(--bg-primary)' }}>

      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <div style={{
          position: 'absolute', width: 650, height: 650, borderRadius: '50%',
          background: `radial-gradient(circle, ${orb[0]} 0%, transparent 70%)`,
          top: '-180px', left: '-120px',
          animation: 'float1 10s ease-in-out infinite',
        }} />
        <div style={{
          position: 'absolute', width: 550, height: 550, borderRadius: '50%',
          background: `radial-gradient(circle, ${orb[1]} 0%, transparent 70%)`,
          bottom: '-120px', right: '-100px',
          animation: 'float2 13s ease-in-out infinite',
        }} />
        <div style={{
          position: 'absolute', width: 380, height: 380, borderRadius: '50%',
          background: `radial-gradient(circle, ${orb[2]} 0%, transparent 70%)`,
          top: '38%', right: '28%',
          animation: 'float3 8s ease-in-out infinite',
        }} />

        {/* Ledger grid, just visible */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: isDark
            ? 'linear-gradient(rgba(240,246,252,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(240,246,252,0.03) 1px, transparent 1px)'
            : 'linear-gradient(rgba(13,17,23,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(13,17,23,0.045) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }} />
      </div>

      <button
        onClick={toggle}
        style={{
          position:       'fixed', top: 20, right: 20, zIndex: 10,
          width:          40, height: 40,
          borderRadius:   '50%',
          border:         '1px solid var(--border)',
          background:     'var(--bg-glass)',
          backdropFilter: 'blur(8px)',
          cursor:         'pointer', fontSize: 16,
          display:        'flex', alignItems: 'center', justifyContent: 'center',
          color:          'var(--text-secondary)',
          transition:     'all 0.2s ease',
          boxShadow:      'var(--shadow-sm)',
        }}
        title={`Switch to ${isDark ? 'light' : 'dark'} theme`}
      >
        {isDark ? '☀' : '◑'}
      </button>

      <div style={{
        position: 'relative', zIndex: 1,
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '40px 20px',
      }}>
        <div style={{
          width: '100%', maxWidth: 420,
          animation: 'scaleIn 0.4s cubic-bezier(0.4,0,0.2,1)',
        }}>

          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div style={{
              width:          52, height: 52, borderRadius: 16,
              background:     'var(--accent-gradient)',
              color:          'var(--accent-text)',
              margin:         '0 auto 16px',
              display:        'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow:      'var(--shadow-md)',
              fontSize:       24, fontWeight: 800,
              animation:      'fadeUp 0.5s ease 0.1s both',
            }}>
              S
            </div>
            <h1 style={{
              fontSize:      26, fontWeight: 800, letterSpacing: '-0.6px',
              color:         'var(--text-primary)',
              marginBottom:  6,
              animation:     'fadeUp 0.4s ease 0.15s both',
            }}>
              Solv Expenses
            </h1>
            <p style={{
              fontSize:  14, color: 'var(--text-muted)', lineHeight: 1.5,
              animation: 'fadeUp 0.4s ease 0.2s both',
            }}>
              {firstRun
                ? 'Create the administrator account and your company'
                : mode === 'login'
                  ? 'Welcome back, sign in to continue'
                  : 'Create a new account'}
            </p>
          </div>

          {/* Card — shake applied here on error */}
          <div style={{
            background:     'var(--bg-glass)',
            backdropFilter: 'blur(24px)',
            border:         '1px solid var(--border-card)',
            borderRadius:   20,
            padding:        '30px 28px',
            boxShadow:      'var(--shadow-lg)',
            animation:      shaking ? 'shake 0.55s ease' : undefined,
          }}>

            {!firstRun && (
              <div style={{
                display:      'flex', gap: 4,
                background:   'var(--bg-input)',
                borderRadius: 10, padding: 4, marginBottom: 24,
              }}>
                {['login', 'register'].map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => switchMode(m)}
                    style={{
                      flex:         1, padding: '8px 0', fontSize: 13, fontWeight: 600,
                      borderRadius: 7, border: 'none', cursor: 'pointer',
                      transition:   'all 0.2s ease',
                      fontFamily:   'inherit',
                      background:   mode === m ? 'var(--bg-card)' : 'transparent',
                      color:        mode === m ? 'var(--text-primary)' : 'var(--text-muted)',
                      boxShadow:    mode === m ? 'var(--shadow-xs)' : 'none',
                    }}
                  >
                    {m === 'login' ? 'Sign in' : 'Register'}
                  </button>
                ))}
              </div>
            )}

            {error && (
              <div className="alert alert-error">
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

            <form
              key={tabKey}
              onSubmit={handleSubmit}
              style={{
                animation: tabKey > 0
                  ? `${slideDir === 'left' ? 'slideFromRight' : 'slideFromLeft'} 0.22s ease`
                  : undefined,
              }}
            >
              <div className="form-group" style={{ animation: 'fadeUp 0.3s ease 0ms both' }}>
                <label htmlFor="login-email" className="form-label">Email address</label>
                <div className="input-wrapper">
                  <input id="login-email"
                    type="email"
                    className="form-input has-icon"
                    placeholder="you@company.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoFocus
                  />
                  <span className="input-icon" style={{ left: 12, top: '50%', transform: 'translateY(-50%)', position: 'absolute', color: 'var(--text-muted)', fontSize: 15 }}>✉</span>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 22, animation: 'fadeUp 0.3s ease 60ms both' }}>
                <label htmlFor="login-password" className="form-label">Password</label>
                <div className="input-wrapper" style={{ position: 'relative' }}>
                  <input id="login-password"
                    type={showPass ? 'text' : 'password'}
                    className="form-input has-icon"
                    placeholder={mode === 'register' ? 'Min. 8 characters' : 'Enter your password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    minLength={mode === 'register' ? 8 : 1}
                    style={{ paddingRight: 42 }}
                  />
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 15 }}>🔒</span>
                  <button
                    type="button"
                    onClick={() => setShowPass(v => !v)}
                    style={{
                      position:  'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', cursor: 'pointer',
                      color:     'var(--text-muted)', fontSize: 14, padding: 2,
                      transition: 'color 0.15s',
                    }}
                    title={showPass ? 'Hide password' : 'Show password'}
                  >
                    {showPass ? '🙈' : '👁'}
                  </button>
                </div>
              </div>

              <div style={{ animation: 'fadeUp 0.3s ease 110ms both' }}>
                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width:       '100%', padding: '12px 0',
                    background:  'var(--accent-gradient)',
                    color:       'var(--accent-text)', border: 'none', borderRadius: 10,
                    fontSize:    15, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
                    fontFamily:  'inherit',
                    display:     'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                    opacity:     loading ? 0.7 : 1,
                    boxShadow:   'var(--shadow-sm)',
                    transition:  'all 0.2s ease',
                  }}
                  onMouseEnter={e => { if (!loading) { e.currentTarget.style.background = 'var(--accent-hover)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--accent-gradient)'; e.currentTarget.style.transform = 'none'; }}
                >
                  {loading && <span className="btn-spinner" />}
                  {loading
                    ? 'Please wait...'
                    : mode === 'login' ? 'Sign in' : 'Create account'}
                </button>
              </div>
            </form>
          </div>

          <p style={{
            textAlign:  'center', marginTop: 20, fontSize: 12,
            color:      'var(--text-muted)',
            animation:  'fadeIn 0.5s ease 0.4s both',
          }}>
            Receipts stay on your company's server.
          </p>
        </div>
      </div>
    </div>
  );
}
