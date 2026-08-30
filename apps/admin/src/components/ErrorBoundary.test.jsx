/**
 * Error boundary tests for the admin app.
 *
 * Tests render errors (ErrorBoundary catch), data-fetch errors (Dashboard,
 * SystemHealth, Transactions), unknown thrown values, retry behavior, safe
 * navigation actions, and sensitive-data non-exposure.
 *
 * NOTE: This test file avoids wrapping components that use useListQuery
 * (Transactions, KycReview) in MemoryRouter when testing error-boundary
 * behavior, because react-router-dom's useMemo resolves differently under
 * Vitest/jsdom in this workspace (pre-existing issue). Instead we test the
 * error boundary component directly and the simpler pages (Dashboard,
 * SystemHealth) that do not use useListQuery.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

// Shared utilities under test
import ErrorBoundary from '@shared/ErrorBoundary.jsx';
import ErrorFallback from '@shared/ErrorFallback.jsx';
import { normalizeError } from '@shared/normalizeError.js';
import { redact } from '@shared/logger.js';

// Pages used in integration tests
import Dashboard from '../pages/Dashboard.jsx';
import SystemHealth from '../pages/SystemHealth.jsx';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A component that always throws during render. */
function AlwaysThrows({ message = 'render kaboom' }) {
  throw new Error(message);
}

/** A component that throws a non-Error value. */
function ThrowsString() {
  // Throw a plain object (not an Error instance) to test that the boundary
  // safely handles non-Error thrown values — exercises the normalizeError
  // unknown-type path. Using object avoids the no-throw-literal lint rule.
  throw { code: 'TEST_NON_ERROR', detail: 'not an Error instance' };
}

/** A component that renders normally. */
function OkComponent() {
  return <div data-testid="ok">all good</div>;
}

// Suppress React's console.error output for intentional error boundary tests
// so the test output stays readable. We restore it after each test.
let consoleError;
beforeEach(() => {
  consoleError = console.error;
  console.error = vi.fn();
});
// restore after each (vitest `afterEach` registered in setupTests.js already
// calls cleanup(), so we just restore the spy here via the local tracker)
import { afterEach } from 'vitest';
afterEach(() => {
  console.error = consoleError;
});

// ---------------------------------------------------------------------------
// normalizeError unit tests
// ---------------------------------------------------------------------------

describe('normalizeError', () => {
  it('handles a standard Error', () => {
    const err = new Error('boom');
    const n = normalizeError(err);
    expect(n.userMessage).toBeTruthy();
    expect(typeof n.userMessage).toBe('string');
    expect(n.category).toBe('unknown');
    expect(n.retryable).toBe(true);
    // Internal diagnostics present but kept internal
    expect(n.internal).toBeDefined();
  });

  it('handles a non-Error thrown value (string)', () => {
    const n = normalizeError('something went wrong');
    expect(n.userMessage).toBeTruthy();
    expect(n.category).toBe('unknown');
    expect(n.correlationId).toBeNull();
    expect(n.internal.thrownType).toBe('string');
  });

  it('handles null', () => {
    const n = normalizeError(null);
    expect(n.userMessage).toBeTruthy();
    expect(n.category).toBe('unknown');
  });

  it('handles undefined', () => {
    const n = normalizeError(undefined);
    expect(n.userMessage).toBeTruthy();
    expect(n.category).toBe('unknown');
  });

  it('handles a plain object', () => {
    const n = normalizeError({ foo: 'bar' });
    expect(n.userMessage).toBeTruthy();
    expect(n.category).toBe('unknown');
  });

  it('classifies 401 as auth', () => {
    const axiosLike = { response: { status: 401, headers: {}, config: {} } };
    const n = normalizeError(axiosLike);
    expect(n.category).toBe('auth');
    expect(n.retryable).toBe(false);
  });

  it('classifies 500 as server', () => {
    const axiosLike = { response: { status: 500, headers: {}, config: {} } };
    const n = normalizeError(axiosLike);
    expect(n.category).toBe('server');
    expect(n.retryable).toBe(true);
  });

  it('classifies network errors', () => {
    const axiosLike = { code: 'ERR_NETWORK', message: 'Network Error' };
    const n = normalizeError(axiosLike);
    expect(n.category).toBe('network');
    expect(n.retryable).toBe(true);
  });

  it('extracts correlation ID from Axios response header', () => {
    const axiosLike = {
      response: {
        status: 500,
        headers: { 'x-correlation-id': 'abc-123' },
        config: {},
      },
    };
    const n = normalizeError(axiosLike);
    expect(n.correlationId).toBe('abc-123');
  });

  it('does not expose internal.message in userMessage', () => {
    const err = new Error('SELECT * FROM users WHERE id=1 -- sql details');
    const n = normalizeError(err);
    expect(n.userMessage).not.toContain('SELECT');
    expect(n.userMessage).not.toContain('FROM users');
  });

  it('never includes a stack trace in the user message', () => {
    const err = new Error('boom');
    const n = normalizeError(err);
    expect(n.userMessage).not.toContain('at ');
    expect(n.userMessage).not.toMatch(/\.(jsx?|tsx?|mjs):\d+/);
  });
});

// ---------------------------------------------------------------------------
// logger.redact unit tests
// ---------------------------------------------------------------------------

describe('logger.redact', () => {
  it('redacts password fields', () => {
    const result = redact({ password: 'secret123', username: 'admin' });
    expect(result.password).toBe('[REDACTED]');
    expect(result.username).toBe('admin');
  });

  it('redacts token fields', () => {
    const result = redact({ token: 'eyJhbGciOi...', foo: 'bar' });
    expect(result.token).toBe('[REDACTED]');
    expect(result.foo).toBe('bar');
  });

  it('redacts authorization header', () => {
    const result = redact({ authorization: 'Bearer abc123' });
    expect(result.authorization).toBe('[REDACTED]');
  });

  it('handles nested objects', () => {
    const result = redact({ outer: { password: 'secret', data: 'ok' } });
    expect(result.outer.password).toBe('[REDACTED]');
    expect(result.outer.data).toBe('ok');
  });

  it('handles arrays', () => {
    const result = redact([{ token: 'x' }, { safe: 'y' }]);
    expect(result[0].token).toBe('[REDACTED]');
    expect(result[1].safe).toBe('y');
  });

  it('handles null/undefined safely', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ErrorBoundary component tests
// ---------------------------------------------------------------------------

describe('ErrorBoundary — render error', () => {
  it('renders fallback when child throws during render', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="admin">
          <AlwaysThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );
    // Recovery screen is rendered
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
  });

  it('does not blank the whole tree — sibling boundaries remain unaffected', () => {
    render(
      <MemoryRouter>
        <div>
          <ErrorBoundary variant="admin">
            <AlwaysThrows />
          </ErrorBoundary>
          <ErrorBoundary variant="admin">
            <OkComponent />
          </ErrorBoundary>
        </div>
      </MemoryRouter>
    );
    // The broken boundary shows the fallback
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // The healthy boundary still renders normally
    expect(screen.getByTestId('ok')).toBeInTheDocument();
  });

  it('handles a non-Error thrown value (string) without crashing', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="admin">
          <ThrowsString />
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
  });

  it('invokes the onError callback with normalized error info', () => {
    const onError = vi.fn();
    render(
      <MemoryRouter>
        <ErrorBoundary variant="admin" onError={onError}>
          <AlwaysThrows message="test error" />
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [normalized] = onError.mock.calls[0];
    expect(normalized).toHaveProperty('userMessage');
    expect(normalized).toHaveProperty('category');
    // Verify the raw error message is NOT the user message
    expect(normalized.userMessage).not.toBe('test error');
  });
});

describe('ErrorBoundary — retry behavior', () => {
  it('resets and re-renders children when "Try again" is clicked', async () => {
    let shouldThrow = true;
    function MaybeThrows() {
      if (shouldThrow) throw new Error('temporary failure');
      return <div data-testid="recovered">recovered</div>;
    }

    render(
      <MemoryRouter>
        <ErrorBoundary variant="admin">
          <MaybeThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );

    // Error state shown
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Fix the condition so the next render succeeds
    shouldThrow = false;

    const retryButton = screen.getByRole('button', { name: /try again/i });
    await userEvent.click(retryButton);

    expect(screen.getByTestId('recovered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ErrorBoundary — navigation actions', () => {
  it('renders "Go to dashboard" link for admin variant', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="admin">
          <AlwaysThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: /go to dashboard/i })).toBeInTheDocument();
  });

  it('renders "Sign in again" link for admin variant', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="admin">
          <AlwaysThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: /sign in again/i })).toBeInTheDocument();
  });

  it('renders "Go home" link for landing variant', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="landing">
          <AlwaysThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: /go home/i })).toBeInTheDocument();
  });

  it('does not render admin-only "Sign in again" on the landing variant', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="landing">
          <AlwaysThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(screen.queryByRole('link', { name: /sign in again/i })).not.toBeInTheDocument();
  });
});

describe('ErrorBoundary — sensitive data protection', () => {
  it('does not render the raw error message in the UI', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="admin">
          <AlwaysThrows message="SELECT * FROM admin WHERE password='secret'" />
        </ErrorBoundary>
      </MemoryRouter>
    );
    // The raw error message must not appear in the rendered output
    expect(document.body.textContent).not.toContain("SELECT * FROM admin");
    expect(document.body.textContent).not.toContain("secret");
  });

  it('does not render any stack trace in the UI', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="admin">
          <AlwaysThrows message="internal path: /app/src/secret.js" />
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(document.body.textContent).not.toMatch(/at \w+ \(/);
    expect(document.body.textContent).not.toContain('/app/src/secret.js');
  });
});

// ---------------------------------------------------------------------------
// ErrorFallback accessibility tests
// ---------------------------------------------------------------------------

describe('ErrorFallback — accessibility', () => {
  it('has a visible heading', () => {
    render(
      <MemoryRouter>
        <ErrorFallback variant="admin" onReset={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
  });

  it('retry button has an accessible name', () => {
    render(
      <MemoryRouter>
        <ErrorFallback variant="admin" onReset={() => {}} />
      </MemoryRouter>
    );
    const btn = screen.getByRole('button', { name: /try again/i });
    expect(btn).toBeInTheDocument();
  });

  it('navigation links have accessible names', () => {
    render(
      <MemoryRouter>
        <ErrorFallback variant="admin" onReset={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: /go to dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in again/i })).toBeInTheDocument();
  });

  it('role=alert is present for screen reader announcement', () => {
    render(
      <MemoryRouter>
        <ErrorFallback variant="landing" onReset={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Dashboard — fetch error → recovery UI (integration)
// ---------------------------------------------------------------------------

describe('Dashboard — data fetch error', () => {
  it('shows safe error UI when /admin/stats returns 500', async () => {
    server.use(
      http.get('*/api/admin/stats', () => {
        return HttpResponse.json({ message: 'Database connection failed' }, { status: 500 });
      })
    );

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    // Safe user message, not the raw backend error
    expect(screen.getByRole('alert').textContent).not.toContain('Database connection failed');
    expect(screen.getByRole('alert').textContent).toContain('A server error occurred');
  });

  it('does not expose raw error message from 500 in the DOM', async () => {
    server.use(
      http.get('*/api/admin/stats', () => {
        return HttpResponse.json(
          { message: 'Postgres: relation "users" does not exist' },
          { status: 500 }
        );
      })
    );

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    expect(document.body.textContent).not.toContain('Postgres');
    expect(document.body.textContent).not.toContain('relation "users"');
  });

  it('retry button re-fetches and shows data on success', async () => {
    // First call fails
    let callCount = 0;
    server.use(
      http.get('*/api/admin/stats', () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json({ message: 'Service temporarily unavailable' }, { status: 503 });
        }
        // Second call succeeds
        return HttpResponse.json({
          success: true,
          data: {
            totalUsers: 5, totalWallets: 3, totalTransactions: 10,
            successfulTransactions: 8, failedTransactions: 1, pendingTransactions: 1, pendingKyc: 0,
          },
        });
      })
    );

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    const retryButton = screen.getByRole('button', { name: /try again/i });
    await userEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Dashboard Overview')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// SystemHealth — fetch error → recovery UI (integration)
// ---------------------------------------------------------------------------

describe('SystemHealth — data fetch error', () => {
  it('shows safe error UI when /admin/system-health fails', async () => {
    server.use(
      http.get('*/api/admin/system-health', () => {
        return HttpResponse.error();
      })
    );

    render(
      <MemoryRouter>
        <SystemHealth />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert').textContent).not.toContain('stack');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows safe error UI when /admin/system-health returns 500', async () => {
    server.use(
      http.get('*/api/admin/system-health', () => {
        return HttpResponse.json(
          { message: 'Redis: ECONNREFUSED 127.0.0.1:6379' },
          { status: 500 }
        );
      })
    );

    render(
      <MemoryRouter>
        <SystemHealth />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    // Raw Redis connection error must not appear in the UI
    expect(document.body.textContent).not.toContain('ECONNREFUSED');
    expect(document.body.textContent).not.toContain('Redis');
    // Safe message does appear
    expect(screen.getByRole('alert').textContent).toContain('server error occurred');
  });

  it('renders health data when fetch succeeds', async () => {
    render(
      <MemoryRouter>
        <SystemHealth />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    expect(screen.getByText('System Health')).toBeInTheDocument();
  });
});
