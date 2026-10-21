import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute.jsx';
import AdminSidebar from './AdminSidebar.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import GlobalSearchModal from './GlobalSearchModal.jsx';

export default function AdminLayout() {
  const [searchModalOpen, setSearchModalOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchModalOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <ProtectedRoute>
      <div className="flex flex-col md:flex-row bg-gray-50 dark:bg-slate-950 text-gray-900 dark:text-gray-100 min-h-screen min-w-0">
        <AdminSidebar onOpenSearch={() => setSearchModalOpen(true)} />
        <div className="flex-1 flex flex-col min-w-0 md:h-[calc(100vh-73px)]">
          <div className="flex justify-end items-center px-4 sm:px-6 lg:px-8 py-2.5 border-b border-gray-100 dark:border-gray-800 bg-white/60 dark:bg-gray-900/60 backdrop-blur-sm">
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
