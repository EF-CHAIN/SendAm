import { useEffect, useState, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Wallet,
  ArrowRightLeft,
  LogOut,
  UserCheck,
  ScrollText,
  Activity,
  ShieldCheck,
} from 'lucide-react';
import { removeToken } from '@/lib/auth';
import { getAdminMe, getAdminKyc } from '@/lib/adminApi';
import { hasPermission } from '@/lib/permissions';

const ALL_LINKS = [
  { name: 'Overview', path: '/', icon: LayoutDashboard, permission: 'admin.read' },
  { name: 'Users', path: '/users', icon: Users, permission: 'admin.read' },
  { name: 'Wallets', path: '/wallets', icon: Wallet, permission: 'admin.read' },
  { name: 'Transactions', path: '/transactions', icon: ArrowRightLeft, permission: 'admin.read' },
  { name: 'KYC', path: '/kyc', icon: UserCheck, permission: 'compliance.read' },
  { name: 'Audit', path: '/audit-logs', icon: ScrollText, permission: 'admin.read' },
  { name: 'Health', path: '/system-health', icon: Activity, permission: 'operations.write' },
];

export default function AdminSidebar({
  onOpenSearch,
  pendingKycCount,
  pollIntervalMs = 15000,
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [permissions, setPermissions] = useState(null);
  const [liveKycCount, setLiveKycCount] = useState(0);
  const [isPulsing, setIsPulsing] = useState(false);
  const prevCountRef = useRef(null);

  const kycCount = typeof pendingKycCount === 'number' ? pendingKycCount : liveKycCount;

  useEffect(() => {
    let active = true;
    getAdminMe()
      .then((me) => {
        if (active) setPermissions(me?.permissions || []);
      })
      .catch(() => {
        if (active) setPermissions([]);
      });
    return () => {
      active = false;
    };
  }, []);

  // Poll for pending KYC submission count in real-time when operator has compliance.read permission
  useEffect(() => {
    if (typeof pendingKycCount === 'number') return;
    if (!permissions || !hasPermission(permissions, 'compliance.read')) return;

    let active = true;
    const fetchPendingKyc = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const res = await getAdminKyc({ status: 'pending', limit: 1 });
        if (active) {
          const total = Number(res?.pagination?.total ?? (Array.isArray(res?.data) ? res.data.length : 0)) || 0;
          setLiveKycCount((prev) => (prev === total ? prev : total));
        }
      } catch {
        // Silently catch network or permission errors during polling
      }
    };

    fetchPendingKyc();
    const timer = setInterval(fetchPendingKyc, pollIntervalMs);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [permissions, pendingKycCount, pollIntervalMs]);

  // Trigger gentle animation pulse whenever the unreviewed count increases
  useEffect(() => {
    if (prevCountRef.current !== null && kycCount > prevCountRef.current) {
      setIsPulsing(true);
      const timer = setTimeout(() => setIsPulsing(false), 1000);
      return () => clearTimeout(timer);
    }
    prevCountRef.current = kycCount;
  }, [kycCount]);

  const links = permissions
    ? ALL_LINKS.filter((l) => hasPermission(permissions, l.permission))
    : [];

  const handleLogout = () => {
    removeToken();
    navigate('/login');
  };

  return (
    <aside className="w-full md:w-64 bg-white dark:bg-slate-900 border-b md:border-b-0 md:border-r border-gray-100 dark:border-slate-800 md:min-h-[calc(100vh-73px)] flex flex-col shrink-0">
      <div className="p-3 sm:p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="hidden md:block text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            Admin Panel
          </h2>
          {onOpenSearch && (
            <button
              type="button"
              onClick={onOpenSearch}
              tabIndex={-1}
              className="hidden md:flex items-center gap-1.5 px-2 py-1 text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 rounded-md transition-colors"
              title="Global search (Cmd+K)"
              data-testid="sidebar-search-btn"
            >
              <span>Search</span>
              <kbd className="text-[10px] bg-white dark:bg-slate-900 px-1 py-0.5 rounded border border-gray-300 dark:border-slate-700">
                ⌘K
              </kbd>
            </button>
          )}
        </div>
        <nav className="grid grid-cols-2 sm:grid-cols-4 md:block gap-2 md:space-y-1">
          {links.map((link) => {
            const Icon = link.icon;
            const isActive = pathname === link.path;
            const isKyc = link.path === '/kyc';
            const showKycBadge = isKyc && kycCount > 0;

            return (
              <div key={link.path} className="relative">
                <Link
                  to={link.path}
                  aria-current={isActive ? 'page' : undefined}
                  aria-describedby={showKycBadge ? 'kyc-pending-count' : undefined}
                  className={`flex items-center justify-between gap-2 md:gap-3 px-3 md:px-4 py-2.5 md:py-3 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-secondary dark:bg-teal-950/50 text-primary dark:text-teal-400'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-slate-800 hover:text-dark dark:hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-2 md:gap-3 min-w-0">
                    <Icon
                      className={`w-5 h-5 shrink-0 ${isActive ? 'text-primary dark:text-teal-400' : 'text-gray-400 dark:text-gray-500'}`}
                    />
                    <span className="truncate">{link.name}</span>
                  </div>
                  {showKycBadge && (
                    <span
                      data-testid="kyc-counter-badge"
                      aria-hidden="true"
                      className={`inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 text-xs font-bold rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-900 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60 shrink-0 transition-transform duration-300 motion-reduce:transition-none motion-reduce:animate-none ${
                        isPulsing ? 'animate-pulse scale-110' : 'scale-100'
                      }`}
                    >
                      {kycCount}
                    </span>
                  )}
                </Link>
                {showKycBadge && (
                  <span id="kyc-pending-count" className="sr-only">
                    {kycCount} pending verification submissions
                  </span>
                )}
              </div>
            );
          })}
          {permissions && (
            <ShieldCheck
              className="w-5 h-5 text-gray-300 dark:text-gray-600 mx-auto mt-2"
              aria-hidden
            />
          )}
        </nav>
      </div>

      <div className="mt-auto p-3 sm:p-4 md:p-6 border-t border-gray-50 dark:border-slate-800/80">
        <button
          onClick={handleLogout}
          className="flex items-center justify-center md:justify-start gap-3 px-4 py-3 w-full rounded-lg text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
        >
          <LogOut className="w-5 h-5 shrink-0" />
          Logout
        </button>
      </div>
    </aside>
  );
}

