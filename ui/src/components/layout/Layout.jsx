import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import BottomNav from './BottomNav';
import { useViewMode } from '../../context/ViewModeContext';

export default function Layout() {
  const { isMobile, mobileDrawerOpen, setMobileDrawerOpen } = useViewMode();
  return (
    <div className={`app-layout ${isMobile ? 'mobile-mode' : ''}`}>
      {isMobile && mobileDrawerOpen && (
        <div onClick={() => setMobileDrawerOpen(false)} aria-hidden="true"
             style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 99, animation: 'fadeIn 0.2s ease' }} />
      )}
      <Sidebar />
      <div className="main-content">
        <Header />
        <div className="page-body">
          <Suspense fallback={<div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading…</div>}><Outlet /></Suspense>
        </div>
      </div>
      {isMobile && <BottomNav />}
    </div>
  );
}
