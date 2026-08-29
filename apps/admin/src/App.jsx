import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import AdminLayout from './components/AdminLayout.jsx';

// Route-level code splitting: each page is its own JS chunk.
// This enables per-route performance budget tracking and keeps
// the initial bundle lean — only the shell loads on first paint.
const Login = lazy(() => import('./pages/Login.jsx'));
const SetPassword = lazy(() => import('./pages/SetPassword.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const Wallets = lazy(() => import('./pages/Wallets.jsx'));
const Transactions = lazy(() => import('./pages/Transactions.jsx'));
const KycReview = lazy(() => import('./pages/KycReview.jsx'));
const AuditLogs = lazy(() => import('./pages/AuditLogs.jsx'));
const SystemHealth = lazy(() => import('./pages/SystemHealth.jsx'));

export default function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/set-password" element={<SetPassword />} />
        <Route element={<AdminLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/users" element={<Users />} />
          <Route path="/wallets" element={<Wallets />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/kyc" element={<KycReview />} />
          <Route path="/audit-logs" element={<AuditLogs />} />
          <Route path="/system-health" element={<SystemHealth />} />
          <Route path="*" element={<Dashboard />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
