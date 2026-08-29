/**
 * Error boundary tests for the landing app.
 *
 * Tests render errors, unknown thrown values, retry behavior, navigation
 * actions, sensitive data protection, and accessibility of the fallback UI.
 *
 * Uses jest-axe for automated accessibility verification of the fallback screen.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { axe } from './test/axe.js';

import ErrorBoundary from '@shared/ErrorBoundary.jsx';
import ErrorFallback from '@shared/ErrorFallback.jsx';
import { normalizeError } from '@shared/normalizeError.js';
import App from './App.jsx';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function AlwaysThrows() {
  throw new Error('intentional test render error');
}

function ThrowsNull() {
  // Throw a plain object (not an Error instance) to test that the boundary
  // safely handles non-Error thrown values — exercises the normalizeError
  // unknown-type path.
  throw { code: 'TEST_NON_ERROR' };
}

function OkComponent() {
  return <div data-testid="ok">healthy</div>;
}

let consoleError;
beforeEach(() => {
  consoleError = console.error;
  console.error = vi.fn();
});
afterEach(() => {
  console.error = consoleError;
});

// ---------------------------------------------------------------------------
// normalizeError (landing context)
// ---------------------------------------------------------------------------

describe('normalizeError — landing context', () => {
  it('never exposes raw thrown message in userMessage', () => {
    const err = new Error('Internal DB error: table=payments col=hash');
    const n = normalizeError(err);
    expect(n.userMessage).not.toContain('DB error');
    expect(n.userMessage).not.toContain('table=payments');
  });

  it('handles thrown null safely', () => {
    const n = normalizeError(null);
    expect(n.userMessage).toBeTruthy();
    expect(n.category).toBe('unknown');
  });

  it('handles thrown number safely', () => {
    const n = normalizeError(42);
    expect(n.userMessage).toBeTruthy();
    expect(n.internal.thrownType).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// ErrorBoundary — landing variant
// ---------------------------------------------------------------------------

describe('ErrorBoundary — landing app render error', () => {
  it('renders fallback when child component throws', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="landing">
          <AlwaysThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
  });

  it('handles null throw without crashing the boundary', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="landing">
          <ThrowsNull />
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('calls onError callback with normalized info', () => {
    const onError = vi.fn();
    render(
      <MemoryRouter>
        <ErrorBoundary variant="landing" onError={onError}>
          <AlwaysThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [normalized] = onError.mock.calls[0];
    // normalized.userMessage must be a safe string, not the raw error message
    expect(normalized.userMessage).not.toBe('intentional test render error');
    expect(normalized.userMessage).toBeTruthy();
  });
});

describe('ErrorBoundary — recovery isolation', () => {
  it('does not destroy sibling boundaries', () => {
    render(
      <MemoryRouter>
        <div>
          <ErrorBoundary variant="landing">
            <AlwaysThrows />
          </ErrorBoundary>
          <ErrorBoundary variant="landing">
            <OkComponent />
          </ErrorBoundary>
        </div>
      </MemoryRouter>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('ok')).toBeInTheDocument();
  });
});

describe('ErrorBoundary — retry', () => {
  it('resets and re-renders children on "Try again"', async () => {
    let shouldThrow = true;

    function Conditional() {
      if (shouldThrow) throw new Error('initial failure');
      return <div data-testid="success">recovered</div>;
    }

    render(
      <MemoryRouter>
        <ErrorBoundary variant="landing">
          <Conditional />
        </ErrorBoundary>
      </MemoryRouter>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByTestId('success')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ErrorBoundary — navigation (landing)', () => {
  it('shows "Go home" link for landing variant', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="landing">
          <AlwaysThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: /go home/i })).toBeInTheDocument();
  });

  it('does not expose admin-only link on landing variant', () => {
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

// ---------------------------------------------------------------------------
// Sensitive data protection
// ---------------------------------------------------------------------------

describe('ErrorBoundary — sensitive data protection', () => {
  it('does not render raw error message', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="landing">
          <AlwaysThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );
    expect(document.body.textContent).not.toContain('intentional test render error');
  });

  it('does not render stack traces', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="landing">
          <AlwaysThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );
    // Stack traces contain patterns like "at ComponentName (path/to/file.jsx:12:5)"
    expect(document.body.textContent).not.toMatch(/at \w+ \(/);
    expect(document.body.textContent).not.toMatch(/\.(jsx?|tsx?|mjs):\d+/);
  });

  it('does not render internal error object keys', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary variant="landing">
          <AlwaysThrows />
        </ErrorBoundary>
      </MemoryRouter>
    );
    // The internal diagnostic object must not appear
    expect(document.body.textContent).not.toContain('"internal"');
    expect(document.body.textContent).not.toContain('"category"');
    expect(document.body.textContent).not.toContain('"correlationId"');
  });
});

// ---------------------------------------------------------------------------
// Accessibility — automated axe scan of the fallback UI
// ---------------------------------------------------------------------------

describe('ErrorFallback — automated accessibility (jest-axe)', () => {
  it('has no automatically detectable accessibility violations (landing)', async () => {
    const { container } = render(
      <MemoryRouter>
        <ErrorFallback variant="landing" onReset={() => {}} />
      </MemoryRouter>
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  }, 15000);

  it('has no automatically detectable accessibility violations (admin)', async () => {
    const { container } = render(
      <MemoryRouter>
        <ErrorFallback variant="admin" onReset={() => {}} />
      </MemoryRouter>
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  }, 15000);

  it('has a visible accessible heading', () => {
    render(
      <MemoryRouter>
        <ErrorFallback variant="landing" onReset={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { level: 1, name: /something went wrong/i })).toBeInTheDocument();
  });

  it('retry button has an accessible name', () => {
    render(
      <MemoryRouter>
        <ErrorFallback variant="landing" onReset={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('all icon-bearing links have visible text labels', () => {
    render(
      <MemoryRouter>
        <ErrorFallback variant="admin" onReset={() => {}} />
      </MemoryRouter>
    );
    // Every <a> must have non-empty text content (icons are aria-hidden)
    const links = screen.getAllByRole('link');
    for (const link of links) {
      expect(link.textContent.trim().length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Full App integration — root boundary wraps the entire app
// ---------------------------------------------------------------------------

describe('Landing App — root error boundary integration', () => {
  it('App renders normally when no error occurs', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
