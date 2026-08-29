import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, Wallet, ArrowRightLeft, LogOut, FileSearch, Activity, ShieldCheck } from 'lucide-react';
import { removeToken } from '@/lib/auth';
import { getAdminMe } from '@/lib/adminApi';
import { hasPermission } from '@/lib/permissions';

const ALL_LINKS = [
  { name: 'Overview', path: '/', icon: LayoutDashboard, permission: 'admin.read' },
  { name: 'Users', path: '/users', icon: Users, permission: 'admin.read' },
  { name: 'Wallets', path: '/wallets', icon: Wallet, permission: 'admin.read' },
  { name: 'Transactions', path: '/transactions', icon: ArrowRightLeft, permission: 'admin.read' },
  { name: 'KYC', path: '/kyc', icon: FileSearch, permission: 'compliance.read' },
  { name: 'Audit', path: '/audit-logs', icon: FileSearch, permission: 'admin.read' },
  { name: 'Health', path: '/system-health', icon: Activity, permission: 'operations.write' },
];

export default function AdminSidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [permissions, setPermissions] = useState(null);

  useEffect(() => {
    let active = true;
    getAdminMe()
      .then((me) => { if (active) setPermissions(me?.permissions || []); })
      .catch(() => { if (active) setPermissions([]); });
    return () => { active = false; };
  }, []);

  const links = permissions ? ALL_LINKS.filter((l) => hasPermission(permissions, l.permission)) : [];

  const handleLogout = () => {
    removeToken();
    navigate('/login');
  };

  return (
    <aside className="w-full md:w-64 bg-white border-b md:border-b-0 md:border-r border-gray-100 md:min-h-[calc(100vh-73px)] flex flex-col shrink-0">
      <div className="p-3 sm:p-4 md:p-6">
        <h2 className="hidden md:block text-xs font-bold text-gray-400 uppercase tracking-wider mb-4">Admin Panel</h2>
        <nav className="grid grid-cols-2 sm:grid-cols-4 md:block gap-2 md:space-y-1">
          {links.map((link) => {
            const Icon = link.icon;
            const isActive = pathname === link.path;
            return (
              <Link
                key={link.path}
                to={link.path}
                className={`flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 md:py-3 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-secondary text-primary'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-dark'
                }`}
              >
                <Icon className={`w-5 h-5 shrink-0 ${isActive ? 'text-primary' : 'text-gray-400'}`} />
                {link.name}
              </Link>
            );
          })}
          {permissions && <ShieldCheck className="w-5 h-5 text-gray-300 mx-auto mt-2" aria-hidden />}
        </nav>
      </div>

      <div className="mt-auto p-3 sm:p-4 md:p-6 border-t border-gray-50">
        <button
          onClick={handleLogout}
          className="flex items-center justify-center md:justify-start gap-3 px-4 py-3 w-full rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
        >
          <LogOut className="w-5 h-5 shrink-0" />
          Logout
        </button>
      </div>
    </aside>
  );
}
