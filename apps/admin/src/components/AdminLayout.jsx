import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import ProtectedRoute from "./ProtectedRoute.jsx";
import AdminSidebar from "./AdminSidebar.jsx";
import GlobalSearchModal from "./GlobalSearchModal.jsx";

export default function AdminLayout() {
  const [searchModalOpen, setSearchModalOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchModalOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <ProtectedRoute>
      <div className="flex flex-col md:flex-row bg-gray-50 min-w-0">
        <AdminSidebar onOpenSearch={() => setSearchModalOpen(true)} />
        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 md:h-[calc(100vh-73px)] overflow-y-auto">
          <Outlet />
        </main>
        <GlobalSearchModal
          isOpen={searchModalOpen}
          onClose={() => setSearchModalOpen(false)}
        />
      </div>
    </ProtectedRoute>
  );
}
