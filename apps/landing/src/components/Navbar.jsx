import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Menu, MessageCircle, X } from 'lucide-react';
import { whatsappUrl } from '@/lib/links.js';

const SECTION_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#faq', label: 'FAQ' },
];

const DRAWER_ID = 'mobile-nav-drawer';
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Locks or releases page scroll behind the open drawer; returns the previous value. */
function setScrollLock(locked, previous = '') {
  const before = document.body.style.overflow;
  document.body.style.overflow = locked ? 'hidden' : previous;
  return before;
}

const desktopLinkClass = 'text-sm font-medium text-slate-600 transition-colors hover:text-primary';
const drawerLinkClass =
  'block rounded-lg px-3 py-3 text-base font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-primary';

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef(null);
  const drawerRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  // While the drawer is open: lock page scroll, move focus inside, close on
  // Escape, keep Tab within the drawer, and hand focus back to the toggle.
  useEffect(() => {
    if (!open) return undefined;

    const drawer = drawerRef.current;
    const toggle = toggleRef.current;
    const previousOverflow = setScrollLock(true);
    drawer?.querySelector(FOCUSABLE)?.focus();

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !drawer) return;

      const focusable = Array.from(drawer.querySelectorAll(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      setScrollLock(false, previousOverflow);
      toggle?.focus();
    };
  }, [open]);

  // Leaving the mobile layout (rotating a tablet, resizing) must not leave the
  // scroll lock behind a menu that is no longer visible.
  useEffect(() => {
    if (!open || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(min-width: 768px)');
    function onChange(event) {
      if (event.matches) setOpen(false);
    }
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, [open]);

  function handleSectionClick(event, href) {
    const target = document.getElementById(href.slice(1));
    if (!target) return; // fall back to the browser's default anchor behaviour
    event.preventDefault();
    // Release the scroll lock first, otherwise the smooth scroll has no effect.
    setScrollLock(false);
    setOpen(false);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', href);
  }

  return (
    <nav className="sticky top-0 z-50 border-b border-slate-100 bg-white/90 backdrop-blur">
      <div className="container mx-auto flex items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link to="/" className="flex shrink-0 items-center gap-2 text-lg font-bold text-primary sm:text-xl">
          <img src="/logo-sent-mark.svg" alt="" className="h-7 w-7 shrink-0" aria-hidden="true" />
          <span>SendAm</span>
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {SECTION_LINKS.map(({ href, label }) => (
            <a key={href} href={href} className={desktopLinkClass}>
              {label}
            </a>
          ))}
          <Link to="/onboarding" className={desktopLinkClass}>
            Onboarding
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <a
            href={whatsappUrl('create wallet')}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-whatsapp focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-whatsapp"
          >
            <MessageCircle size={16} aria-hidden="true" />
            <span className="hidden sm:inline">Open WhatsApp</span>
            <span className="sm:hidden">Start</span>
          </a>

          <button
            ref={toggleRef}
            type="button"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls={DRAWER_ID}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden"
          >
            {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {open &&
        // Portalled out of <nav>: its backdrop-blur would otherwise become the
        // containing block for this fixed overlay and clip it to the navbar.
        createPortal(
          <div className="fixed inset-0 z-50 md:hidden">
            <div
              data-testid="nav-backdrop"
              className="absolute inset-0 bg-slate-900/40"
              aria-hidden="true"
              onClick={close}
            />
            <div
              ref={drawerRef}
              id={DRAWER_ID}
              role="dialog"
              aria-modal="true"
              aria-label="Site navigation"
              className="absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col gap-1 bg-white p-4 shadow-xl"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-base font-bold text-primary">Menu</span>
                <button
                  type="button"
                  aria-label="Close menu"
                  onClick={close}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <X size={22} aria-hidden="true" />
                </button>
              </div>

              {SECTION_LINKS.map(({ href, label }) => (
                <a
                  key={href}
                  href={href}
                  className={drawerLinkClass}
                  onClick={(event) => handleSectionClick(event, href)}
                >
                  {label}
                </a>
              ))}
              <Link to="/onboarding" className={drawerLinkClass} onClick={close}>
                Onboarding
              </Link>

              <a
                href={whatsappUrl('create wallet')}
                target="_blank"
                rel="noopener noreferrer"
                onClick={close}
                className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-whatsapp focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-whatsapp"
              >
                <MessageCircle size={16} aria-hidden="true" />
                Open WhatsApp
              </a>
            </div>
          </div>,
          document.body,
        )}
    </nav>
  );
}
