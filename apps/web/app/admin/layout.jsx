'use client';
import { usePathname } from 'next/navigation';
import ProtectedRoute from '@/components/ProtectedRoute';
import AdminSidebar from '@/components/AdminSidebar';

export default function AdminLayout({ children }) {
  const pathname = usePathname();
  
  // Don't apply sidebar and protection to the login page
  if (pathname === '/admin/login') {
    return <>{children}</>;
  }

  return (
    <ProtectedRoute>
      <div className="flex flex-col md:flex-row bg-gray-50 min-w-0">
        <AdminSidebar />
        <div className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 md:h-[calc(100vh-73px)] overflow-y-auto">
          {children}
        </div>
      </div>
    </ProtectedRoute>
  );
}
