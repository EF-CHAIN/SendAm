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
  X,
} from 'lucide-react';
import { removeToken } from '@/lib/auth';
import { getAdminMe } from '@/lib/adminApi';
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

export default function AdminSidebar({ onOpenSearch, isOpen = false, onClose }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [permissions, setPermissions] = useState(null);
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia?.('(min-width: 1024px)').matches ?? true);
  const dialogRef = useRef(null);
  const swipeStart = useRef(null);

  useEffect(() => {
    const query = window.matchMedia?.('(min-width: 1024px)');
    if (!query) return;
    const resize = (event) => {
      setIsDesktop(event.matches);
      if (event.matches) onClose?.();
    };
    query.addEventListener('change', resize);
    return () => query.removeEventListener('change', resize);
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || isDesktop || !isOpen) {
      if (dialog?.open) dialog.close();
      return;
    }
    // Native modal semantics provide focus trapping and inert background content.
    dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, [isDesktop, isOpen]);

  const closeDrawer = () => onClose?.();
  const openSearch = () => { closeDrawer(); onOpenSearch?.(); };
  const finishSwipe = (event) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    const end = event.changedTouches[0];
    if (!start || !end) return;
    const distance = start.x - end.clientX;
    if (distance >= 60 && distance > Math.abs(start.y - end.clientY) * 1.5) closeDrawer();
  };

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

  const links = permissions
    ? ALL_LINKS.filter((l) => hasPermission(permissions, l.permission))
    : [];

  const handleLogout = () => {
    closeDrawer();
    removeToken();
    navigate('/login');
  };

  const content = (
    <>
      <div className="p-3 sm:p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 id="admin-navigation-title" className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            Admin Panel
          </h2>
          {onOpenSearch && (
            <button
              type="button"
              onClick={openSearch}
              tabIndex={isDesktop ? -1 : 0}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 rounded-md transition-colors"
              title="Global search (Cmd+K)"
              data-testid="sidebar-search-btn"
            >
              <span>Search</span>
              <kbd className="text-[10px] bg-white dark:bg-slate-900 px-1 py-0.5 rounded border border-gray-300 dark:border-slate-700">
                ⌘K
              </kbd>
            </button>
          )}
          {!isDesktop && (
            <button type="button" onClick={closeDrawer} aria-label="Close navigation" className="p-2 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800">
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          )}
        </div>
        <nav aria-label="Admin navigation" className="space-y-1">
          {links.map((link) => {
            const Icon = link.icon;
            const isActive = pathname === link.path;
            return (
              <Link
                key={link.path}
                to={link.path}
                onClick={closeDrawer}
                aria-current={isActive ? 'page' : undefined}
                className={`flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 md:py-3 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-secondary dark:bg-teal-950/50 text-primary dark:text-teal-400'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-slate-800 hover:text-dark dark:hover:text-white'
                }`}
              >
                <Icon
                  className={`w-5 h-5 shrink-0 ${isActive ? 'text-primary dark:text-teal-400' : 'text-gray-400 dark:text-gray-500'}`}
                />
                {link.name}
              </Link>
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
    </>
  );

  if (isDesktop) {
    return <aside className="w-64 bg-white dark:bg-slate-900 border-r border-gray-100 dark:border-slate-800 min-h-[calc(100vh-73px)] flex flex-col shrink-0">{content}</aside>;
  }

  return (
    <>
      <style>{`
        .admin-mobile-drawer {
          transform: translateX(-100%);
          opacity: 0;
          transition: transform 200ms ease, opacity 200ms ease, display 200ms allow-discrete, overlay 200ms allow-discrete;
        }
        .admin-mobile-drawer[open] { transform: translateX(0); opacity: 1; }
        .admin-mobile-drawer::backdrop {
          background: rgb(15 23 42 / 50%);
          opacity: 0;
          transition: opacity 200ms ease, display 200ms allow-discrete, overlay 200ms allow-discrete;
        }
        .admin-mobile-drawer[open]::backdrop { opacity: 1; }
        @starting-style {
          .admin-mobile-drawer[open] { transform: translateX(-100%); opacity: 0; }
          .admin-mobile-drawer[open]::backdrop { opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .admin-mobile-drawer, .admin-mobile-drawer::backdrop { transition: none; }
        }
      `}</style>
      <dialog
        id="admin-mobile-navigation"
        ref={dialogRef}
        aria-labelledby="admin-navigation-title"
        aria-modal="true"
        className="admin-mobile-drawer fixed inset-y-0 left-0 right-auto m-0 h-[100dvh] max-h-none w-72 max-w-[calc(100vw-3rem)] p-0 border-0 bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100 shadow-xl"
        onCancel={(event) => { event.preventDefault(); closeDrawer(); }}
        onClose={() => { if (!dialogRef.current?.open) closeDrawer(); }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDrawer();
        }}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          swipeStart.current = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
        }}
        onTouchEnd={finishSwipe}
        onTouchCancel={() => { swipeStart.current = null; }}
      >
        <div className="min-h-full flex flex-col">{content}</div>
      </dialog>
    </>
  );
}
