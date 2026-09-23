import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useViewMode } from '../../context/ViewModeContext';

const NAV = [
  { to: '/',         label: 'Home',        desc: 'Your cases and where the money goes', end: true },
  { to: '/expenses', label: 'My receipts', desc: 'Every receipt you recorded' },
  { to: '/reports',  label: 'Cases',       desc: 'Open, claim, export' },
];
// The admin's seat is for running the company and watching it work, not for
// approving anything: settings and staff, and every case there is.
const ADMIN_NAV = [{ to: '/settings', label: 'Settings', desc: 'Company, staff, reader, Xero' }];

function Item({ to, label, desc, end, onClick }) {
  return (
    <NavLink to={to} end={end} onClick={onClick}
      style={({ isActive }) => ({
        display: 'flex', flexDirection: 'column', gap: 1, padding: '9px 12px', borderRadius: 10, marginBottom: 2, textDecoration: 'none',
        fontSize: 13, fontWeight: isActive ? 600 : 500, color: isActive ? 'var(--text-sidebar-active)' : 'var(--text-sidebar)',
        background: isActive ? 'var(--accent-subtle)' : 'transparent', transition: 'all 0.18s ease',
      })}>
      <span>{label}</span>
      <span style={{ fontSize: 10.5, opacity: 0.6 }}>{desc}</span>
    </NavLink>
  );
}

export default function Sidebar() {
  const { user, logout } = useAuth();
  const { isMobile, mobileDrawerOpen, setMobileDrawerOpen } = useViewMode();
  const navigate = useNavigate();
  const close = () => { if (isMobile) setMobileDrawerOpen(false); };
  const canAdmin = user?.role === 'admin';

  return (
    <aside style={{
      position: 'fixed', top: 0, left: 0, bottom: 0, width: isMobile ? 'min(290px, 82vw)' : 'var(--sidebar-width)',
      background: 'var(--bg-sidebar)', borderRight: '1px solid var(--border-sidebar)', display: 'flex', flexDirection: 'column', zIndex: 100,
      transform: isMobile ? (mobileDrawerOpen ? 'translateX(0)' : 'translateX(-100%)') : 'none', transition: 'transform 0.25s ease',
    }}>
      <div style={{ padding: '20px 16px 14px', borderBottom: '1px solid var(--border-sidebar)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 11 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-gradient)', color: 'var(--accent-text)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 16 }}>S</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.2 }}>Solv Expenses</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{user?.companyName || 'Claims'}</div>
        </div>
        {isMobile && <button onClick={() => setMobileDrawerOpen(false)} aria-label="Close menu" style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18 }}>✕</button>}
      </div>
      <nav style={{ flex: 1, padding: '0 8px', overflow: 'auto' }}>
        {NAV.map(i => <Item key={i.to} {...i} onClick={close} />)}
        {canAdmin && ADMIN_NAV.map(i => <Item key={i.to} {...i} onClick={close} />)}
      </nav>
      <div style={{ margin: '8px 8px 12px', padding: '12px 14px', borderRadius: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name || user?.email}</div>
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 8 }}>{user?.role}{user?.department ? ` · ${user.department}` : ''}</div>
        <button className="btn btn-outline btn-sm" style={{ width: '100%' }} onClick={() => { close(); logout(); navigate('/login'); }}>Sign out</button>
      </div>
    </aside>
  );
}
