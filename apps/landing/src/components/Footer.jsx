import { ExternalLink } from 'lucide-react';
import { ADMIN_URL, GITHUB_URL, STELLAR_URL, whatsappUrl } from '@/lib/links.js';

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
        <div className="container mx-auto flex flex-col gap-2 px-4 py-6 text-center text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:text-left">
          <p>&copy; {new Date().getFullYear()} SendAm. All rights reserved.</p>
          <p className="text-xs text-slate-400">
            MVP on Stellar Testnet — not for real-money use yet.
          </p>
        </div>
      </div>
    </footer>
  );
}
