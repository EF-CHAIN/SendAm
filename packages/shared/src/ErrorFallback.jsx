/**
 * ErrorFallback — recovery UI shown when an ErrorBoundary catches a render error.
 *
 * Accessibility:
 *  - role="alert" announces the failure to screen readers immediately
 *  - Meaningful heading for the error state
 *  - All interactive controls have visible focus rings and accessible names
 *  - Navigation actions vary by variant: admin vs landing
 *
 * Security:
 *  - Never renders error.message, error.stack, component names, or file paths
 *  - Never renders raw API responses, correlation IDs, or internal IDs
 *  - All user-visible copy is static, safe, and informative without leaking details
 *
 * @param {Object} props
 * @param {'admin'|'landing'} [props.variant='landing'] - Controls navigation targets
 * @param {() => void} props.onReset - Callback to reset the error boundary (retry)
 */
export default function ErrorFallback({ variant = 'landing', onReset }) {
  const isAdmin = variant === 'admin';

  const homeHref = isAdmin ? '/' : '/';
  const homeLabel = isAdmin ? 'Go to dashboard' : 'Go home';
  const loginHref = '/login';

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex min-h-[60vh] items-center justify-center px-4 py-12"
    >
      <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-8 shadow-sm text-center">
        {/* Icon — decorative, hidden from assistive technology */}
        <div
          aria-hidden="true"
          className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-red-50"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-8 w-8 text-red-500"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>

        {/* Heading — required for accessibility: descriptive, not alarming */}
        <h1 className="mb-3 text-xl font-bold text-gray-900">
          Something went wrong
        </h1>

        <p className="mb-2 text-sm text-gray-600">
          An unexpected error occurred. The rest of the application is still
          available.
        </p>
        <p className="mb-8 text-sm text-gray-500">
          You can try again, or navigate to a safe page.
        </p>

        {/* Action buttons */}
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          {/* Primary: retry — resets the error boundary so React re-renders the tree */}
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M21 2v6h-6" />
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M3 22v-6h6" />
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
            Try again
          </button>

          {/* Secondary: navigate home / dashboard */}
          <a
            href={homeHref}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            {homeLabel}
          </a>

          {/* Admin-only: login link (useful if the error is session-related) */}
          {isAdmin && (
            <a
              href={loginHref}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" y1="12" x2="3" y2="12" />
              </svg>
              Sign in again
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
