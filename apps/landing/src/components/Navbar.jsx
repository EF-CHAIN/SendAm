import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Globe, Menu, MessageCircle, Moon, Sun, X } from 'lucide-react';
import { whatsappUrl } from '@/lib/links.js';
import { LANGUAGES, useI18n } from '@/lib/i18n.js';

const SECTION_LINKS = [
  { href: '#features', labelKey: 'nav.features' },
  { href: '#how-it-works', labelKey: 'nav.howItWorks' },
  { href: '#faq', labelKey: 'nav.faq' },
];

const DRAWER_ID = 'mobile-nav-drawer';
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Locks or releases page scroll behind the open drawer; returns the previous value. */
function setScrollLock(locked, previous = '') {
  const before = document.body.style.overflow;
  document.body.style.overflow = locked ? 'hidden' : previous;
  return before;
}

const desktopLinkBaseClass =
  'relative pb-1 text-sm font-medium transition-all duration-200 border-b-2';
const getDesktopLinkClass = (isActive) =>
  `${desktopLinkBaseClass} ${
    isActive
      ? 'text-primary border-primary font-semibold'
      : 'text-slate-600 border-transparent hover:text-primary'
  }`;

const drawerLinkBaseClass =
  'block rounded-lg px-3 py-3 text-base font-medium transition-colors border-l-4';
const getDrawerLinkClass = (isActive) =>
  `${drawerLinkBaseClass} ${
    isActive
      ? 'border-primary bg-primary/5 text-primary font-semibold'
      : 'border-transparent text-slate-700 hover:bg-slate-50 hover:text-primary'
  }`;

export default function Navbar({ theme = 'light', onToggleTheme } = {}) {
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('');
  const [shown, setShown] = useState(false);
  const toggleRef = useRef(null);
  const drawerRef = useRef(null);
  const { lang, setLang, t } = useI18n();

  const close = useCallback(() => setOpen(false), []);

  // Track viewport intersection of major section tags for scroll-spy highlighting (#743)
  useEffect(() => {
    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return undefined;

    const sectionElements = SECTION_LINKS.map(({ href }) =>
      document.getElementById(href.slice(1))
    ).filter(Boolean);

    if (sectionElements.length === 0) return undefined;

    const visibleRatios = new Map();

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          visibleRatios.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
        });

        let bestId = '';
        let highestRatio = 0;
        visibleRatios.forEach((ratio, id) => {
          if (ratio > highestRatio) {
            highestRatio = ratio;
            bestId = id;
          }
        });

        if (bestId && highestRatio > 0) {
          setActiveSection(`#${bestId}`);
        }
      },
      {
        root: null,
        rootMargin: '-20% 0px -40% 0px',
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      }
    );

    sectionElements.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, []);

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

  // Mount closed, then flip on the next frame so the backdrop fades in.
  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => setShown(true));
    return () => {
      cancelAnimationFrame(frame);
      setShown(false);
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
    setActiveSection(href);
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
          {SECTION_LINKS.map(({ href, labelKey }) => {
            const isActive = activeSection === href;
            return (
              <a
                key={href}
                href={href}
                className={getDesktopLinkClass(isActive)}
                onClick={(event) => handleSectionClick(event, href)}
                aria-current={isActive ? 'true' : undefined}
                data-active={isActive ? 'true' : undefined}
              >
                {t(labelKey)}
              </a>
            );
          })}
          <Link to="/onboarding" className={`${desktopLinkBaseClass} text-slate-600 border-transparent hover:text-primary`}>
            {t('nav.onboarding')}
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5 text-slate-600 transition-colors focus-within:border-primary hover:border-slate-300 sm:flex">
            <Globe size={15} aria-hidden="true" className="shrink-0" />
            <select
              value={lang}
              onChange={(event) => setLang(event.target.value)}
              aria-label={t('nav.language')}
              className="cursor-pointer rounded bg-transparent text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {LANGUAGES.map(({ code, nativeLabel }) => (
                <option key={code} value={code}>
                  {nativeLabel}
                </option>
              ))}
            </select>
          </div>

          <a
            href={whatsappUrl('create wallet')}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-whatsapp focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-whatsapp"
          >
            <MessageCircle size={16} aria-hidden="true" />
            <span className="hidden sm:inline">{t('nav.openWhatsApp')}</span>
            <span className="sm:hidden">{t('nav.start')}</span>
          </a>

          {onToggleTheme && (
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {theme === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
            </button>
          )}

          <button
            ref={toggleRef}
            type="button"
            aria-label={open ? t('nav.closeMenu') : t('nav.openMenu')}
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
              className={`absolute inset-0 bg-slate-900/40 backdrop-blur-md transition-opacity duration-300 motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0'}`}
              aria-hidden="true"
              onClick={close}
            />
            <div
              ref={drawerRef}
              id={DRAWER_ID}
              role="dialog"
              aria-modal="true"
              aria-label={t('nav.siteNavigation')}
              className="absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col gap-1 bg-white p-4 shadow-xl"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-base font-bold text-primary">{t('nav.menu')}</span>
                <button
                  type="button"
                  aria-label={t('nav.closeMenu')}
                  onClick={close}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <X size={22} aria-hidden="true" />
                </button>
              </div>

              {SECTION_LINKS.map(({ href, labelKey }) => {
                const isActive = activeSection === href;
                return (
                  <a
                    key={href}
                    href={href}
                    className={getDrawerLinkClass(isActive)}
                    onClick={(event) => handleSectionClick(event, href)}
                    aria-current={isActive ? 'true' : undefined}
                    data-active={isActive ? 'true' : undefined}
                  >
                    {t(labelKey)}
                  </a>
                );
              })}
              <Link to="/onboarding" className={`${drawerLinkBaseClass} border-transparent text-slate-700 hover:bg-slate-50 hover:text-primary`} onClick={close}>
                {t('nav.onboarding')}
              </Link>

              <div className="mt-2 flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-slate-600">
                <Globe size={15} aria-hidden="true" className="shrink-0" />
                <select
                  value={lang}
                  onChange={(event) => setLang(event.target.value)}
                  aria-label={t('nav.language')}
                  className="w-full cursor-pointer rounded bg-transparent text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {LANGUAGES.map(({ code, nativeLabel }) => (
                    <option key={code} value={code}>
                      {nativeLabel}
                    </option>
                  ))}
                </select>
              </div>

              <a
                href={whatsappUrl('create wallet')}
                target="_blank"
                rel="noopener noreferrer"
                onClick={close}
                className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-whatsapp focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-whatsapp"
              >
                <MessageCircle size={16} aria-hidden="true" />
                {t('nav.openWhatsApp')}
              </a>
            </div>
          </div>,
          document.body,
        )}
    </nav>
  );
}
