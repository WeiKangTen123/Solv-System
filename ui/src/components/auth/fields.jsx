import { Link } from 'react-router-dom';

// The pieces of the sign-in and sign-up forms that are the same on both.

// A password box with its lock and a show/hide switch. `autoComplete` tells a
// password manager whether to fill the saved password or offer to save a new
// one: "current-password" on sign-in, "new-password" on sign-up.
export function PasswordField({ id, label, value, onChange, show, onToggleShow, placeholder, autoComplete, minLength, describedBy, style }) {
  return (
    <div className="form-group" style={style}>
      <label htmlFor={id} className="form-label">{label}</label>
      <div className="input-wrapper" style={{ position: 'relative' }}>
        <input id={id}
          type={show ? 'text' : 'password'}
          className="form-input has-icon"
          placeholder={placeholder}
          value={value}
          onChange={e => onChange(e.target.value)}
          required
          minLength={minLength}
          autoComplete={autoComplete}
          aria-describedby={describedBy}
          style={{ paddingRight: 42 }}
        />
        <span aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 15 }}>🔒</span>
        {onToggleShow && (
          <button
            type="button"
            onClick={onToggleShow}
            aria-label={show ? 'Hide password' : 'Show password'}
            aria-pressed={show}
            style={{
              position:  'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer',
              color:     'var(--text-muted)', fontSize: 14, padding: 2,
              transition: 'color 0.15s',
            }}
            title={show ? 'Hide password' : 'Show password'}
          >
            {show ? '🙈' : '👁'}
          </button>
        )}
      </div>
    </div>
  );
}

// The form's one big button, with a spinner while it waits.
export function SubmitButton({ loading, children }) {
  return (
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
      {loading ? 'Please wait...' : children}
    </button>
  );
}

// "New to Solv? Create an account →" under the card, and the way back.
export function SwitchLink({ prompt, to, children }) {
  return (
    <p style={{ textAlign: 'center', marginTop: 18, fontSize: 13.5, color: 'var(--text-secondary)', animation: 'fadeIn 0.5s ease 0.3s both' }}>
      {prompt}{' '}
      <Link to={to} style={{ color: 'var(--text-primary)', fontWeight: 600, textDecoration: 'none', borderBottom: '1px solid var(--border)' }}>
        {children}
      </Link>
    </p>
  );
}
