import { Component } from 'react';
import { normalizeError } from './normalizeError.js';
import { logger } from './logger.js';
import ErrorFallback from './ErrorFallback.jsx';

// Only these bounded, redacted strings may be shown or copied. Never serialize
// the thrown object: request/response data can contain credentials and PII.
function sanitizeDiagnostic(value, fallback = 'Not available') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:authorization|set-cookie|cookie)\s*[:=][^\r\n]+/gi, '[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?(?:password|access[_ -]?token|refresh[_ -]?token|token|api[_ -]?key|private[_ -]?key|secret|seed|pin)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\bS[A-Z2-7]{55}\b/g, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
    .replace(/\b(?:https?|file|webpack(?:-internal)?):\/\/[^\s)]+/gi, '[URL]')
    .replace(/\b[A-Z]:[\\/][^\r\n)]+|(?<![\w])(?:\/[^\s/()]+)+/gi, '[path]')
    .slice(0, 6000);
}

function buildDiagnostics(error, componentStack) {
  // Accessors on arbitrary thrown values may themselves throw.
  const read = (key) => {
    try { return error?.[key]; } catch { return undefined; }
  };
  return [
    `Error name: ${sanitizeDiagnostic(read('name'), 'Error')}`,
    `Message: ${sanitizeDiagnostic(typeof error === 'string' ? error : read('message'))}`,
    `Stack:\n${sanitizeDiagnostic(read('stack'))}`,
    `Component stack:\n${sanitizeDiagnostic(componentStack)}`,
    `Browser user agent: ${sanitizeDiagnostic(typeof navigator === 'undefined' ? '' : navigator.userAgent)}`,
  ].join('\n\n');
}

/**
 * ErrorBoundary — React class component error boundary.
 *
 * Class components are required for error boundaries because React's
 * getDerivedStateFromError and componentDidCatch lifecycle methods are only
 * available on class components (as of React 19).
 *
 * SCOPE:
 *  Catches synchronous render errors and lifecycle errors within its subtree.
 *  Does NOT catch errors inside event handlers, async operations, or errors
 *  thrown outside the React render tree — those should continue to be handled
 *  via try/catch in the component itself.
 *
 * SECURITY:
 *  - Normalizes all thrown values before rendering
 *  - Keeps the default recovery copy generic
 *  - Exposes only redacted text diagnostics in the opt-in technical details
 *  - Logs internal diagnostics (correlation ID, error category, path) to
 *    console; never renders the internal diagnostic object or response payloads
 *  - In development React already logs full stack details to console
 *
 * @prop {'admin'|'landing'} [variant='landing'] - Controls fallback UI navigation
 * @prop {React.ReactNode} children - Subtree to protect
 * @prop {Function} [onError] - Optional callback for external error reporting
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      normalized: null,
      diagnostics: '',
      retryCount: 0,
    };
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(error) {
    // Normalize the thrown value immediately so the render phase always
    // receives a safe, structured representation.
    const normalized = normalizeError(error);
    return { hasError: true, normalized };
  }

  componentDidCatch(error, errorInfo) {
    const normalized = normalizeError(error);
    this.setState({ diagnostics: buildDiagnostics(error, errorInfo?.componentStack) });

    // Logging remains separate from the explicitly sanitized support report.
    logger.error('ErrorBoundary caught a render error', {
      category: normalized.category,
      correlationId: normalized.correlationId,
      internal: normalized.internal,
      // componentStack is available for dev tooling; it contains component
      // names (which may include file paths in dev builds). The support report
      // above strips those paths before it can be displayed or copied.
      componentStack: errorInfo?.componentStack
        ? errorInfo.componentStack.slice(0, 400)
        : undefined,
    });

    // Propagate to any external error handler (e.g. a test spy or monitoring hook).
    if (typeof this.props.onError === 'function') {
      try {
        this.props.onError(normalized, errorInfo);
      } catch {
        // Never crash inside error-handling code
      }
    }
  }

  handleReset() {
    // Log the retry attempt for observability.
    logger.info('ErrorBoundary reset — user triggered retry', {
      correlationId: this.state.normalized?.correlationId ?? null,
    });
    this.setState((state) => ({
      hasError: false, normalized: null, diagnostics: '', retryCount: state.retryCount + 1,
    }));
  }

  render() {
    if (this.state.hasError) {
      // Custom fallback takes precedence (for route-level isolation).
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback({
          normalized: this.state.normalized,
          onReset: this.handleReset,
        });
      }

      return (
        <ErrorFallback
          key={this.state.retryCount}
          variant={this.props.variant ?? 'landing'}
          onReset={this.handleReset}
          diagnostics={this.state.diagnostics}
        />
      );
    }

    return this.props.children;
  }
}
