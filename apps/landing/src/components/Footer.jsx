import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { ADMIN_URL, GITHUB_URL, STELLAR_URL, STELLAR_STATUS_URL, whatsappUrl } from '@/lib/links.js';

export function StellarStatusBadge() {
  const [status, setStatus] = useState('Operational');

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    async function fetchStatus() {
      try {
        const res = await fetch('https://status.stellar.org/api/v2/status.json', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const data = await res.json();
        const indicator = data?.status?.indicator;
        if (!active) return;
        if (indicator === 'none') {
          setStatus('Operational');
        } else if (indicator === 'minor') {
          setStatus('Degraded');
        } else if (indicator === 'major' || indicator === 'critical') {
          setStatus('Incident');
        }
      } catch {
        if (active) {
          setStatus('Operational');
        }
      }
    }

    fetchStatus();
    const interval = setInterval(fetchStatus, 60000);

    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  const isDegraded = status === 'Degraded';
  const isIncident = status === 'Incident';

  const colorStyles = isIncident
    ? {
        badge: 'border-rose-200/80 bg-rose-50/80 text-rose-800 hover:border-rose-300 hover:bg-rose-100/80',
        pingDot: 'bg-rose-400',
        solidDot: 'bg-rose-500',
      }
    : isDegraded
    ? {
        badge: 'border-amber-200/80 bg-amber-50/80 text-amber-800 hover:border-amber-300 hover:bg-amber-100/80',
        pingDot: 'bg-amber-400',
        solidDot: 'bg-amber-500',
      }
    : {
        badge: 'border-emerald-200/80 bg-emerald-50/80 text-emerald-800 hover:border-emerald-300 hover:bg-emerald-100/80',
        pingDot: 'bg-emerald-400',
        solidDot: 'bg-emerald-500',
      };

  return (
    <a
      href={STELLAR_STATUS_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="View official Stellar network status page"
      aria-label={`Network status: Stellar Mainnet: ${status} (opens in new window)`}
      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${colorStyles.badge}`}
    >
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:hidden ${colorStyles.pingDot}`}
        />
        <span className={`relative inline-flex h-2 w-2 rounded-full ${colorStyles.solidDot}`} />
      </span>
      <span>Stellar Mainnet: {status}</span>
      <span className="sr-only">(opens in new window)</span>
    </a>
  );
}

const columns = [
  {
    title: 'Product',
    links: [
      { label: 'Features', href: '#features' },
      { label: 'How it works', href: '#how-it-works' },
      { label: 'FAQ', href: '#faq' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { label: 'GitHub', href: GITHUB_URL, external: true },
      { label: 'Stellar', href: STELLAR_URL, external: true },
      { label: 'Admin dashboard', href: ADMIN_URL },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="mt-auto border-t border-slate-100 bg-slate-50">
      <div className="container mx-auto grid gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.5fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold text-primary">
            <img src="/logo-sent-mark.svg" alt="" className="h-6 w-6" aria-hidden="true" />
            <span>SendAm</span>
          </div>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-slate-500">
            WhatsApp-first payments powered by the Stellar network.
          </p>
          <a
            href={whatsappUrl('create wallet')}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-block text-sm font-semibold text-whatsapp-dark hover:underline"
          >
            Start on WhatsApp →
          </a>
        </div>

        {columns.map((col) => (
          <div key={col.title}>
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">
              {col.title}
            </h2>
            <ul className="mt-4 space-y-3">
              {col.links.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    {...(link.external
                      ? { target: '_blank', rel: 'noopener noreferrer' }
                      : {})}
                    className="inline-flex items-center gap-1 text-sm text-slate-600 transition-colors hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    {link.label}
                    {link.external && (
                      <>
                        <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
                        <span className="sr-only">(opens in new window)</span>
                      </>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-slate-100">
        <div className="container mx-auto flex flex-col items-center gap-4 px-4 py-6 text-center text-sm text-slate-500 sm:flex-row sm:justify-between sm:px-6 sm:text-left">
          <div className="flex flex-wrap items-center justify-center gap-3 sm:justify-start">
            <p>&copy; {new Date().getFullYear()} SendAm. All rights reserved.</p>
            <span className="hidden text-slate-300 sm:inline" aria-hidden="true">•</span>
            <StellarStatusBadge />
          </div>
          <p className="text-xs text-slate-400">
            MVP on Stellar Testnet — not for real-money use yet.
          </p>
        </div>
      </div>
    </footer>
  );
}
