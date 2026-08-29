import { Component } from 'react';
import { normalizeError } from './normalizeError.js';
import { logger } from './logger.js';
import ErrorFallback from './ErrorFallback.jsx';

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
 *  - Only renders the sanitized userMessage in the UI
 *  - Logs internal diagnostics (correlation ID, error category, path) to
 *    console; never exposes stack traces, raw messages, or tokens to the user
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

    // Internal logging — safe diagnostics only, no stack trace rendered to UI.
    logger.error('ErrorBoundary caught a render error', {
      category: normalized.category,
      correlationId: normalized.correlationId,
      internal: normalized.internal,
      // componentStack is available for dev tooling; it contains component
      // names (which may include file paths in dev builds). We log it only
      // to the console, never render it.
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
    this.setState({ hasError: false, normalized: null });
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
          variant={this.props.variant ?? 'landing'}
          onReset={this.handleReset}
        />
      );
    }

    return this.props.children;
  }
}
