import { Routes, Route } from 'react-router-dom';
import AdminLayout from './components/AdminLayout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Users from './pages/Users.jsx';
import Wallets from './pages/Wallets.jsx';
import Transactions from './pages/Transactions.jsx';
import Escrows from './pages/Escrows.jsx';
import KycReview from './pages/KycReview.jsx';
import AuditLogs from './pages/AuditLogs.jsx';
import SystemHealth from './pages/SystemHealth.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AdminLayout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/users" element={<Users />} />
        <Route path="/wallets" element={<Wallets />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/escrows" element={<Escrows />} />
        <Route path="/kyc" element={<KycReview />} />
        <Route path="/audit-logs" element={<AuditLogs />} />
        <Route path="/system-health" element={<SystemHealth />} />
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
  );
}
