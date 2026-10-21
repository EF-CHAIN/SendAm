import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Calculator, UserCheck, HelpCircle, Home, Search, ArrowRight } from 'lucide-react';

const RECOVERY_ROUTES = [
  {
    title: 'Home',
    path: '/',
    category: 'Main',
    description: 'Return to SendAm homepage, rates, and features',
  },
  {
    title: 'Currency Calculator',
    path: '/#calculator',
    category: 'Tools',
    description: 'Live fiat-to-crypto rates and transparent flat 1% fees',
  },
  {
    title: 'Check Onboarding Status',
    path: '/onboarding',
    category: 'Account',
    description: 'Track your WhatsApp wallet setup, KYC, and limits',
  },
  {
    title: 'Frequently Asked Questions',
    path: '/#faq',
    category: 'Help',
    description: 'Answers about security, speed, fees, and Stellar settlements',
  },
  {
    title: 'How SendAm Works',
    path: '/#how-it-works',
    category: 'Guide',
    description: 'Step-by-step walkthrough of WhatsApp payments on Stellar',
  },
  {
    title: 'Key Features',
    path: '/#features',
    category: 'Product',
    description: 'Explore biometric confirmations, instant liquidity, and low fees',
  },
];

export function NotFoundIllustration() {
  return (
    <div
      className="relative mx-auto mb-6 flex h-44 w-44 sm:h-52 sm:w-52 items-center justify-center"
      aria-hidden="true"
    >
      {/* Soft atmospheric gradient glow */}
      <div className="absolute inset-0 rounded-full bg-emerald-100/70 blur-2xl motion-reduce:hidden" />
      <svg
        className="relative h-full w-full drop-shadow-sm"
        viewBox="0 0 240 240"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-hidden="true"
      >
        {/* Orbital trajectory lines */}
        <circle cx="120" cy="120" r="96" stroke="#E2E8F0" strokeWidth="2" strokeDasharray="5 7" />
        <circle cx="120" cy="120" r="72" stroke="#CBD5E1" strokeWidth="1.5" />
        <circle cx="120" cy="120" r="48" stroke="#94A3B8" strokeWidth="1.5" strokeDasharray="3 5" />

        {/* Central beacon / compass radar */}
        <rect
          x="75"
          y="75"
          width="90"
          height="90"
          rx="24"
          fill="#FFFFFF"
          stroke="#0D9488"
          strokeWidth="3"
        />

        {/* 404 Motif */}
        <text
          x="120"
          y="128"
          textAnchor="middle"
          fontSize="30"
          fontWeight="800"
          fill="#0D9488"
          fontFamily="system-ui, -apple-system, sans-serif"
        >
          404
        </text>

        {/* Floating node points */}
        <circle cx="50" cy="80" r="6" fill="#10B981" />
        <circle cx="190" cy="70" r="5" fill="#0D9488" />
        <circle cx="180" cy="170" r="7" fill="#10B981" opacity="0.8" />
        <circle cx="65" cy="175" r="5.5" fill="#059669" />

        {/* Pulse trails */}
        <path d="M50 80 L75 95" stroke="#10B981" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.6" />
        <path d="M190 70 L160 90" stroke="#0D9488" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.6" />
        <path d="M180 170 L155 145" stroke="#10B981" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.6" />
        <path d="M65 175 L90 150" stroke="#059669" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.6" />
      </svg>
    </div>
  );
}

export default function NotFound() {
  const [searchQuery, setSearchQuery] = useState('');

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const filteredRoutes = trimmedQuery
    ? RECOVERY_ROUTES.filter(
        (r) =>
          r.title.toLowerCase().includes(trimmedQuery) ||
          r.description.toLowerCase().includes(trimmedQuery) ||
          r.category.toLowerCase().includes(trimmedQuery)
      )
    : [];

  return (
    <div className="container mx-auto flex min-h-[75vh] flex-col items-center justify-center px-4 py-16 text-center sm:px-6 lg:py-24">
      {/* Responsive Illustration */}
      <NotFoundIllustration />

      <h1 className="text-3xl font-extrabold tracking-tight text-dark sm:text-4xl">
        404 - Page Not Found
      </h1>
      <p className="mt-3 max-w-lg text-base leading-relaxed text-slate-600 sm:text-lg">
        The page you are looking for does not exist or has been moved. Explore popular destinations below or search for available features.
      </p>

      {/* Quick Action Pills */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          to="/#calculator"
          className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50/80 px-4 py-2 text-sm font-semibold text-emerald-800 transition-colors hover:border-emerald-300 hover:bg-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Calculator size={16} aria-hidden="true" />
          <span>Go to Calculator</span>
        </Link>
        <Link
          to="/onboarding"
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-primary/40 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <UserCheck size={16} aria-hidden="true" />
          <span>Check Onboarding Status</span>
        </Link>
        <Link
          to="/#faq"
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-primary/40 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <HelpCircle size={16} aria-hidden="true" />
          <span>Browse FAQ</span>
        </Link>
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Home size={16} aria-hidden="true" />
          <span>Return Home</span>
        </Link>
      </div>

      {/* Quick Route Search */}
      <div className="mt-8 w-full max-w-md">
        <div className="relative">
          <Search
            size={18}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search available routes (e.g. calculator, faq)..."
            aria-label="Search available routes"
            className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-4 text-sm text-dark placeholder-slate-400 shadow-sm transition focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {/* Filtered Search Results Dropdown/List */}
        {trimmedQuery.length > 0 && (
          <div
            role="region"
            aria-live="polite"
            className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg text-left"
          >
            {filteredRoutes.length > 0 ? (
              <ul className="divide-y divide-slate-100 max-h-60 overflow-y-auto" role="list">
                {filteredRoutes.map((route) => (
                  <li key={route.path}>
                    <Link
                      to={route.path}
                      className="group flex items-center justify-between p-3.5 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <div>
                        <div className="text-sm font-semibold text-dark group-hover:text-primary">
                          {route.title}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">{route.description}</div>
                      </div>
                      <ArrowRight
                        size={16}
                        className="text-slate-400 group-hover:text-primary shrink-0 ml-3 transition-transform group-hover:translate-x-0.5"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4 text-center text-sm text-slate-500">
                No matching routes found for &ldquo;{searchQuery}&rdquo;. Try &ldquo;calculator&rdquo; or &ldquo;onboarding&rdquo;.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
