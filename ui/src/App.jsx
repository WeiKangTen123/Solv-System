import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { ViewModeProvider } from './context/ViewModeContext';
import { ConfirmProvider } from './context/ConfirmContext';
import Layout from './components/layout/Layout';
import Login from './pages/Login';

const Capture       = lazy(() => import('./pages/Capture'));
const Home          = lazy(() => import('./pages/Home'));
const MyExpenses    = lazy(() => import('./pages/MyExpenses'));
const ExpenseReview = lazy(() => import('./pages/ExpenseReview'));
const Settings      = lazy(() => import('./pages/Settings'));
const Reports       = lazy(() => import('./pages/Reports'));
const ReportDetail  = lazy(() => import('./pages/ReportDetail'));
const CaseCheck     = lazy(() => import('./pages/CaseCheck'));

const Loading = <div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading…</div>;

function Private({ children, roles }) {
  const { user, loading } = useAuth();
  if (loading) return Loading;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return (
    <Suspense fallback={Loading}>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
        {/* No login on purpose: the pairing token in the URL is the phone's only credential. */}
        <Route path="/capture/:token" element={<Capture />} />
        <Route path="/" element={<Private><Layout /></Private>}>
          <Route index element={<Home />} />
          <Route path="expenses" element={<MyExpenses />} />
          <Route path="expenses/:id" element={<ExpenseReview />} />
          <Route path="reports" element={<Reports />} />
          <Route path="reports/:id" element={<ReportDetail />} />
          <Route path="reports/:id/check" element={<CaseCheck />} />
          <Route path="settings" element={<Private roles={['admin']}><Settings /></Private>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ThemeProvider><ViewModeProvider><AuthProvider><ConfirmProvider>
      <BrowserRouter><AppRoutes /></BrowserRouter>
    </ConfirmProvider></AuthProvider></ViewModeProvider></ThemeProvider>
  );
}
