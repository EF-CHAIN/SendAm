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
      <div className="flex bg-gray-50">
        <AdminSidebar />
        <div className="flex-1 p-8 h-[calc(100vh-73px)] overflow-y-auto">
          {children}
        </div>
      </div>
    </ProtectedRoute>
  );
}
