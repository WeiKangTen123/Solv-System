import { NavLink } from 'react-router-dom';
import { useTheme } from '../../context/ThemeContext';

const NAV_ITEMS = [
  { to: '/',         label: 'Home',     icon: '▦', end: true },
  { to: '/expenses', label: 'Expenses', icon: '◧' },
  { to: '/reports',  label: 'Reports',  icon: '▤' },
  { to: '/settings', label: 'Settings', icon: '◈' },
];

export default function BottomNav() {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, height: 'var(--bottom-nav-total)',
      background: isDark ? 'rgba(12, 18, 17, 0.95)' : 'rgba(255, 255, 255, 0.95)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
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
              <span style={{ fontSize: 10, fontWeight: isActive ? 700 : 500, letterSpacing: '-0.01em' }}>{item.label}</span>
              {isActive && <span style={{ position: 'absolute', top: 0, width: 24, height: 3, borderRadius: '0 0 3px 3px', background: 'var(--accent)' }} />}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
