import { useTheme } from '../../context/ThemeContext';

// The frame the sign-in and sign-up pages share: the quiet background, the
// theme switch, the mark and the name, and the card the form sits in. One
// frame so the two pages cannot drift apart.
//
// Every colour here comes from the palette. The sign-in page used to carry
// fourteen hex values of its own, inherited from the app it was ported from,
// so it was the one screen that did not change when the theme did — you
// signed in to one product and landed in another.
export default function AuthShell({ subtitle, shaking = false, children, below }) {
  const { theme, toggle } = useTheme();
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
        type="button"
        onClick={toggle}
        aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
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
              {subtitle}
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
            {children}
          </div>

          {below}

          <p style={{
            textAlign:  'center', marginTop: 20, fontSize: 12,
            color:      'var(--text-muted)',
            animation:  'fadeIn 0.5s ease 0.4s both',
          }}>
            Receipts stay on your company&rsquo;s server.
          </p>
        </div>
      </div>
    </div>
  );
}
