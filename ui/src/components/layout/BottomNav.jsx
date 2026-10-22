import { NavLink } from 'react-router-dom';

// The same four tabs for everyone, Settings included: every person has a
// profile, a password and their preferences there (the route is open to all),
// and an admin finds the company's controls behind the same tab.
//
// Named as the sidebar names them. "My receipts" fits a quarter of a 320px
// screen at this size, so it is not shortened to a word the sidebar does not
// use.
const ALL = [
  { to: '/',         label: 'Home',        icon: '▦', end: true },
  { to: '/reports',  label: 'Cases',       icon: '▤' },
  { to: '/expenses', label: 'My receipts', icon: '◧' },
  { to: '/settings', label: 'Settings',    icon: '◈' },
];

export default function BottomNav() {
  const NAV_ITEMS = ALL;
  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, height: 'var(--bottom-nav-total)',
      background: 'var(--bg-glass)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
      borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-around', zIndex: 90,
      padding: '0 8px var(--safe-bottom)', boxShadow: '0 -2px 10px rgba(0,0,0,0.06)',
    }}>
      {NAV_ITEMS.map(item => (
        <NavLink key={item.to} to={item.to} end={item.end}
          style={({ isActive }) => ({ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', flex: 1, height: '100%',
                                      color: isActive ? 'var(--accent)' : 'var(--text-muted)', transition: 'color 0.15s ease', position: 'relative' })}>
          {({ isActive }) => (
            <>
              <span style={{ fontSize: 19, lineHeight: 1, marginBottom: 3, transform: isActive ? 'scale(1.1)' : 'scale(1)', transition: 'transform 0.15s ease' }}>{item.icon}</span>
              <span style={{ fontSize: 10, fontWeight: isActive ? 700 : 500, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{item.label}</span>
              {isActive && <span style={{ position: 'absolute', top: 0, width: 24, height: 3, borderRadius: '0 0 3px 3px', background: 'var(--accent)' }} />}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
