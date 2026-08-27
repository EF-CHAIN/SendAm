import { Routes, Route } from 'react-router-dom';
import ErrorBoundary from '@shared/ErrorBoundary.jsx';
import AdminLayout from './components/AdminLayout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Users from './pages/Users.jsx';
import Wallets from './pages/Wallets.jsx';
import Transactions from './pages/Transactions.jsx';
import KycReview from './pages/KycReview.jsx';
import AuditLogs from './pages/AuditLogs.jsx';
import SystemHealth from './pages/SystemHealth.jsx';

export default function App() {
  return (
    <ErrorBoundary variant="admin">
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<AdminLayout />}>
          <Route path="/" element={<ErrorBoundary variant="admin"><Dashboard /></ErrorBoundary>} />
          <Route path="/users" element={<ErrorBoundary variant="admin"><Users /></ErrorBoundary>} />
          <Route path="/wallets" element={<ErrorBoundary variant="admin"><Wallets /></ErrorBoundary>} />
          <Route path="/transactions" element={<ErrorBoundary variant="admin"><Transactions /></ErrorBoundary>} />
          <Route path="/kyc" element={<ErrorBoundary variant="admin"><KycReview /></ErrorBoundary>} />
          <Route path="/audit-logs" element={<ErrorBoundary variant="admin"><AuditLogs /></ErrorBoundary>} />
          <Route path="/system-health" element={<ErrorBoundary variant="admin"><SystemHealth /></ErrorBoundary>} />
          <Route path="*" element={<ErrorBoundary variant="admin"><Dashboard /></ErrorBoundary>} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
