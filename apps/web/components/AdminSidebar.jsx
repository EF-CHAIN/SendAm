'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, Users, Wallet, ArrowRightLeft, LogOut } from 'lucide-react';
import { removeToken } from '@/lib/auth';

export default function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const links = [
    { name: 'Overview', path: '/admin', icon: LayoutDashboard },
    { name: 'Users', path: '/admin/users', icon: Users },
    { name: 'Wallets', path: '/admin/wallets', icon: Wallet },
    { name: 'Transactions', path: '/admin/transactions', icon: ArrowRightLeft },
  ];

  const handleLogout = () => {
    removeToken();
    router.push('/admin/login');
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
                href={link.path}
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
