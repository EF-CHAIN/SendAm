import { useState, useEffect, useCallback, useRef } from 'react';
import { ShieldCheck, Cookie, X, SlidersHorizontal, Check } from 'lucide-react';
import {
  hasConsentBeenGiven,
  saveConsent,
  getStoredConsent,
} from '@/lib/consentStorage';

export default function CookieConsentBanner() {
  const [isVisible, setIsVisible] = useState(() => !hasConsentBeenGiven());
  const [showPreferences, setShowPreferences] = useState(false);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(() =>
    Boolean(getStoredConsent()?.analytics)
  );
  const [marketingEnabled, setMarketingEnabled] = useState(() =>
    Boolean(getStoredConsent()?.marketing)
  );

  const modalRef = useRef(null);

  const handleAcceptAll = useCallback(() => {
    saveConsent({ necessary: true, analytics: true, marketing: true });
    setIsVisible(false);
    setShowPreferences(false);
  }, []);

  const handleRejectNonEssential = useCallback(() => {
    saveConsent({ necessary: true, analytics: false, marketing: false });
    setIsVisible(false);
    setShowPreferences(false);
  }, []);

  const handleSavePreferences = useCallback(() => {
    saveConsent({
      necessary: true,
      analytics: analyticsEnabled,
      marketing: marketingEnabled,
    });
    setIsVisible(false);
    setShowPreferences(false);
  }, [analyticsEnabled, marketingEnabled]);

  // Modal keyboard containment: close on Escape
  useEffect(() => {
    if (!showPreferences) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setShowPreferences(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showPreferences]);

  if (!isVisible && !showPreferences) return null;

  return (
    <>
      {/* Bottom Floating Consent Banner */}
      {isVisible && !showPreferences && (
        <section
          role="region"
          aria-label="Cookie and data privacy consent"
          data-testid="cookie-consent-banner"
          className="fixed bottom-0 inset-x-0 z-50 p-4 sm:p-5 bg-white/95 dark:bg-gray-900/95 backdrop-blur-md border-t border-gray-200 dark:border-gray-800 shadow-2xl transition-all duration-300"
        >
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="flex items-start gap-3 flex-1">
              <div className="p-2 rounded-lg bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 flex-shrink-0 mt-0.5">
                <Cookie className="w-5 h-5" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-1.5">
                  <span>Data Privacy & Cookie Choices</span>
                  <span className="text-[10px] font-medium tracking-wide uppercase px-1.5 py-0.2 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                    GDPR / NDPR
                  </span>
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed max-w-3xl">
                  SendAm uses strictly necessary cookies and local storage to secure transaction routing and account authentication.
                  With your consent, we also use optional analytics cookies to measure feature performance and improve user onboarding.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto justify-end">
              <button
                type="button"
                onClick={() => setShowPreferences(true)}
                data-testid="consent-customize"
                className="px-3 py-2 text-xs font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors flex items-center gap-1.5 focus:outline-hidden focus:ring-2 focus:ring-teal-500"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Customize</span>
              </button>
              <button
                type="button"
                onClick={handleRejectNonEssential}
                data-testid="consent-reject-non-essential"
                className="px-3.5 py-2 text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors focus:outline-hidden focus:ring-2 focus:ring-teal-500"
              >
                Reject Non-Essential
              </button>
              <button
                type="button"
                onClick={handleAcceptAll}
                data-testid="consent-accept-all"
                className="px-4 py-2 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-xs transition-colors flex items-center gap-1.5 focus:outline-hidden focus:ring-2 focus:ring-teal-500 focus:ring-offset-1"
              >
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Accept All</span>
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Granular Preferences Modal */}
      {showPreferences && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="consent-preferences-title"
          data-testid="consent-preferences-modal"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
        >
          <div
            ref={modalRef}
            className="w-full max-w-lg bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 p-6 space-y-5"
          >
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
                <h3
                  id="consent-preferences-title"
                  className="text-base font-bold text-gray-900 dark:text-white"
                >
                  Cookie & Privacy Preferences
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowPreferences(false)}
                aria-label="Close preferences"
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded-lg"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>

            <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
              Under the Nigeria Data Protection Regulation (NDPR) and GDPR, you have full control over non-essential data collection.
              Customize your preferences below.
            </p>

            {/* Granular Toggles */}
            <div className="space-y-3">
              {/* Strictly Necessary */}
              <div className="p-3.5 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/40 flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <span className="text-xs font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
                    Strictly Necessary Cookies
                    <span className="text-[10px] font-semibold text-teal-700 dark:text-teal-400 bg-teal-100 dark:bg-teal-900/40 px-1.5 py-0.2 rounded">
                      Always Active
                    </span>
                  </span>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">
                    Required for core security, session continuity, payment verification, and local cryptographic state.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={true}
                  disabled
                  aria-label="Strictly necessary cookies always enabled"
                  className="mt-1 h-4 w-4 text-teal-600 rounded opacity-60 cursor-not-allowed"
                />
              </div>

              {/* Analytics */}
              <label
                htmlFor="consent-toggle-analytics"
                className="p-3.5 rounded-xl border border-gray-200 dark:border-gray-800 hover:border-teal-300 dark:hover:border-teal-700 bg-white dark:bg-gray-900 flex items-start justify-between gap-3 cursor-pointer transition-colors"
              >
                <div className="space-y-0.5">
                  <span className="text-xs font-bold text-gray-900 dark:text-white">
                    Analytics & Performance
                  </span>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">
                    Aggregated usage metrics helping us optimize payment speed, WhatsApp handoff, and mobile responsiveness.
                  </p>
                </div>
                <input
                  id="consent-toggle-analytics"
                  type="checkbox"
                  checked={analyticsEnabled}
                  onChange={(e) => setAnalyticsEnabled(e.target.checked)}
                  data-testid="consent-toggle-analytics"
                  className="mt-1 h-4 w-4 text-teal-600 rounded border-gray-300 dark:border-gray-600 focus:ring-teal-500 cursor-pointer"
                />
              </label>

              {/* Marketing */}
              <label
                htmlFor="consent-toggle-marketing"
                className="p-3.5 rounded-xl border border-gray-200 dark:border-gray-800 hover:border-teal-300 dark:hover:border-teal-700 bg-white dark:bg-gray-900 flex items-start justify-between gap-3 cursor-pointer transition-colors"
              >
                <div className="space-y-0.5">
                  <span className="text-xs font-bold text-gray-900 dark:text-white">
                    Marketing & Feature Updates
                  </span>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">
                    Relevant notifications about new Stellar corridors, stablecoin liquidity, and currency conversions.
                  </p>
                </div>
                <input
                  id="consent-toggle-marketing"
                  type="checkbox"
                  checked={marketingEnabled}
                  onChange={(e) => setMarketingEnabled(e.target.checked)}
                  data-testid="consent-toggle-marketing"
                  className="mt-1 h-4 w-4 text-teal-600 rounded border-gray-300 dark:border-gray-600 focus:ring-teal-500 cursor-pointer"
                />
              </label>
            </div>

            {/* Modal Actions */}
            <div className="pt-2 flex items-center justify-between gap-3 border-t border-gray-100 dark:border-gray-800">
              <button
                type="button"
                onClick={handleRejectNonEssential}
                className="px-3.5 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
              >
                Reject All Non-Essential
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSavePreferences}
                  data-testid="consent-save-preferences"
                  className="px-4 py-2 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg shadow-xs transition-colors"
                >
                  Save Preferences
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
