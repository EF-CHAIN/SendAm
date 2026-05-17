import Link from 'next/link';
import { Send } from 'lucide-react';

export default function Navbar() {
  return (
    <nav className="bg-white border-b border-gray-100 py-3 sm:py-4 sticky top-0 z-50">
      <div className="container mx-auto px-4 sm:px-6 flex justify-between items-center gap-4">
        <Link href="/" className="flex items-center gap-2 text-primary font-bold text-lg sm:text-xl shrink-0">
          <Send className="w-6 h-6 shrink-0" />
          <span>SendAm</span>
        </Link>
        <div className="flex gap-3 sm:gap-6 items-center justify-end min-w-0">
          <Link href="/wallet-test" className="text-sm font-medium text-gray-600 hover:text-primary transition-colors">
            Wallet Test
          </Link>
          <Link href="/admin/login" className="text-sm font-medium text-gray-600 hover:text-primary transition-colors">
            Admin
          </Link>
        </div>
      </div>
    </nav>
  );
}
