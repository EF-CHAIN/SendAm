import { useState, useEffect, useCallback } from 'react';
import { Menu } from 'lucide-react';
import { Outlet, useLocation } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute.jsx';
import AdminSidebar from './AdminSidebar.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import GlobalSearchModal from './GlobalSearchModal.jsx';

export default function AdminLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const { key: locationKey } = useLocation();
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize drawer with browser/back/programmatic navigation
    setDrawerOpen(false);
  }, [locationKey]);
  const [searchModalOpen, setSearchModalOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setDrawerOpen(false);
        setSearchModalOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <ProtectedRoute>
      <div className="flex flex-col lg:flex-row bg-gray-50 dark:bg-slate-950 text-gray-900 dark:text-gray-100 min-h-screen min-w-0">
        <AdminSidebar isOpen={drawerOpen} onClose={closeDrawer} onOpenSearch={() => setSearchModalOpen(true)} />
        <div className="flex-1 flex flex-col min-w-0 lg:h-[calc(100vh-73px)]">
          <div className="flex justify-between lg:justify-end items-center px-4 sm:px-6 lg:px-8 py-2.5 border-b border-gray-100 dark:border-gray-800 bg-white/60 dark:bg-gray-900/60 backdrop-blur-sm">
            <button
              type="button"
              className="lg:hidden p-2 rounded-lg text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
              aria-label="Open navigation"
              aria-controls="admin-mobile-navigation"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((open) => !open)}
            >
              <Menu className="w-6 h-6" aria-hidden="true" />
            </button>
            <ThemeToggle />
          </div>
          <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 overflow-y-auto">
            <Outlet />
          </main>
        </div>
        <GlobalSearchModal
          isOpen={searchModalOpen}
          onClose={() => setSearchModalOpen(false)}
        />
      </div>
    </ProtectedRoute>
  );
}
