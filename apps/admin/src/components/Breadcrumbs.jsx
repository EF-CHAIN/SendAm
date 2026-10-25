import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';

const ROUTE_LABELS = {
  '': 'Dashboard',
  users: 'Users',
  wallets: 'Wallets',
  transactions: 'Transactions',
  kyc: 'KYC Review',
  'audit-logs': 'Audit Logs',
  'system-health': 'System Health',
};

function formatSegment(segment) {
  if (ROUTE_LABELS[segment]) {
    return ROUTE_LABELS[segment];
  }
  // If it's a code/ID like SDA-9284 or hex, keep it intact
  if (/^[a-zA-Z0-9_-]+$/.test(segment) && (segment.includes('-') || segment.length > 8)) {
    return segment;
  }
  // Otherwise capitalize words
  return segment
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export default function Breadcrumbs() {
  const { pathname } = useLocation();

  // Split path into segments, ignoring empty strings
  const segments = pathname.split('/').filter(Boolean);

  // If on root dashboard '/', no parent or deep breadcrumb needed
  if (segments.length === 0) {
    return null;
  }

  const breadcrumbItems = [
    { name: 'Dashboard', path: '/', isLast: false },
  ];

  let currentPath = '';
  segments.forEach((segment, index) => {
    currentPath += `/${segment}`;
    breadcrumbItems.push({
      name: formatSegment(segment),
      path: currentPath,
      isLast: index === segments.length - 1,
    });
  });

  return (
    <nav aria-label="Breadcrumb" className="mb-4 sm:mb-6">
      <ol className="flex items-center flex-wrap gap-1 sm:gap-2 text-sm text-gray-500">
        {breadcrumbItems.map((item, index) => {
          const isFirst = index === 0;

          return (
            <li key={item.path} className="flex items-center gap-1 sm:gap-2">
              {!isFirst && (
                <ChevronRight
                  className="w-4 h-4 text-gray-400 shrink-0"
                  aria-hidden="true"
                />
              )}
              {item.isLast ? (
                <span
                  className="font-semibold text-gray-900 truncate max-w-[200px] sm:max-w-xs"
                  aria-current="page"
                >
                  {item.name}
                </span>
              ) : (
                <Link
                  to={item.path}
                  className="hover:text-primary transition-colors flex items-center gap-1"
                >
                  {isFirst && <Home className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                  <span>{item.name}</span>
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
