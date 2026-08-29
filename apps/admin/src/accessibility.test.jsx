import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from './App.jsx';
import StatusBadge from './components/StatusBadge.jsx';
import { setToken, removeToken } from './lib/auth';
import { axe } from './test/axe';
import { server } from './mocks/server';
import { http, HttpResponse } from 'msw';

// Accessibility coverage for the critical admin dashboard workflows:
// navigation, tables, pagination, forms, status indicators, keyboard
// operation and axe scans of the real rendered routes. Runs in CI via
// `npm run test --workspace=apps/admin` (see .github/workflows/test.yml).
//
// Note: the admin dashboard currently has no dialogs/modals, so dialog
// coverage is intentionally absent rather than testing invented markup.

// Render the real app (sidebar + protected layout + page) against MSW.
const renderAdmin = (path = '/') => {
  setToken('a11y-test-token');
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
};

const renderLogin = () => {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <App />
    </MemoryRouter>
  );
};

const waitForTable = async () => {
  await waitFor(() => {
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
};

// Heading levels must never skip more than one level (decreases are fine for
// new sections). Mirrors what axe's heading-order rule enforces.
const expectNoSkippedHeadingLevels = () => {
  const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)));
  for (let i = 1; i < levels.length; i++) {
    expect(levels[i]).toBeLessThanOrEqual(levels[i - 1] + 1);
  }
};

describe('admin dashboard accessibility', () => {
  afterEach(() => {
    removeToken();
  });

  describe('navigation & landmarks', () => {
    it('exposes navigation and main landmarks on the authenticated layout', async () => {
      renderAdmin('/');
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Dashboard Overview' })).toBeInTheDocument();
      });
      expect(screen.getByRole('navigation')).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
      expect(screen.getAllByRole('main')).toHaveLength(1);
    });

    it('gives every sidebar link and the logout button a meaningful accessible name', () => {
      renderAdmin('/');
      const expectedLinks = [
        ['Overview', '/'],
        ['Users', '/users'],
        ['Wallets', '/wallets'],
        ['Transactions', '/transactions'],
        ['KYC', '/kyc'],
        ['Audit', '/audit-logs'],
        ['Health', '/system-health'],
      ];
      for (const [name, href] of expectedLinks) {
        const link = screen.getByRole('link', { name });
        expect(link).toHaveAttribute('href', href);
      }
      expect(screen.getByRole('button', { name: /logout/i })).toBeInTheDocument();
    });

    it('renders exactly one top-level h1 on every dashboard page', async () => {
      for (const path of ['/', '/users', '/transactions', '/kyc', '/audit-logs']) {
        const { unmount } = renderAdmin(path);
        await waitFor(() => {
          expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        });
        expectNoSkippedHeadingLevels();
        unmount();
      }
    });

    it('reaches every nav link and the logout button via the keyboard in DOM order', async () => {
      renderAdmin('/');
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Dashboard Overview' })).toBeInTheDocument();
      });
      const user = userEvent.setup();
      await user.tab();
      expect(screen.getByRole('link', { name: 'Overview' })).toHaveFocus();
      for (const name of ['Users', 'Wallets', 'Transactions', 'KYC', 'Audit', 'Health']) {
        await user.tab();
        expect(screen.getByRole('link', { name })).toHaveFocus();
      }
      await user.tab();
      expect(screen.getByRole('button', { name: /logout/i })).toHaveFocus();
    });

    it('navigates to a section with the Enter key on a focused nav link', async () => {
      renderAdmin('/');
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Dashboard Overview' })).toBeInTheDocument();
      });
      const user = userEvent.setup();
      await user.tab(); // Overview
      await user.tab(); // Users
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Users' })).toBeInTheDocument();
      });
    });
  });

  describe('dashboard', () => {
    it('announces the loading state and renders stats with a logical heading structure', async () => {
      const { container } = renderAdmin('/');
      // Synchronously after mount the shared Loader exposes a live status region.
      expect(screen.getByRole('status')).toBeInTheDocument();
      const loadingResults = await axe(container);
      expect(loadingResults).toHaveNoViolations();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Dashboard Overview' })).toBeInTheDocument();
      });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expectNoSkippedHeadingLevels();

      // Stat values are data, not headings.
      expect(screen.getByText('42')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: '42' })).not.toBeInTheDocument();
    });

    it('surfaces the stats error as an accessible alert', async () => {
      server.use(
        http.get('*/api/admin/stats', () =>
          HttpResponse.json({ message: 'Stats unavailable' }, { status: 500 })
        )
      );
      renderAdmin('/');
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/request failed/i);
      });
    });
  });

  describe('data tables', () => {
    it('renders transactions with semantic table markup and column headers', async () => {
      renderAdmin('/transactions');
      await waitForTable();
      const table = screen.getByRole('table');
      const headers = within(table).getAllByRole('columnheader');
      expect(headers.map((h) => h.textContent)).toEqual([
        'User Phone', 'Type', 'Amount', 'Rail', 'Destination', 'Receipt', 'Status', 'Date',
      ]);
      for (const th of headers) {
        expect(th).toHaveAttribute('scope', 'col');
      }
      // Header row + at least one data row.
      expect(within(table).getAllByRole('row').length).toBeGreaterThanOrEqual(2);
    });

    it('exposes empty table results as visible text', async () => {
      server.use(
        http.get('*/api/admin/transactions', () =>
          HttpResponse.json({
            data: [],
            pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: 0 },
          })
        )
      );
      renderAdmin('/transactions');
      await waitFor(() => {
        expect(screen.getByText('No records found.')).toBeInTheDocument();
      });
    });
  });

  describe('pagination', () => {
    it('renders Prev/Next controls with correct disabled state on the first page', async () => {
      renderAdmin('/transactions');
      await waitForTable();
      expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /next/i })).toBeEnabled();
    });

    it('navigates pages with the keyboard and updates the disabled state', async () => {
      renderAdmin('/transactions');
      await waitForTable();
      const user = userEvent.setup();
      screen.getByRole('button', { name: /next/i }).focus();
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(screen.getByText('No records found.')).toBeInTheDocument();
      });
      // After moving forward the cursors flip: Prev becomes available.
      expect(screen.getByRole('button', { name: /prev/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    });
  });

  describe('forms', () => {
    it('associates login labels with their controls and marks them required', () => {
      renderLogin();
      expect(screen.getByLabelText('Email')).toBeRequired();
      expect(screen.getByLabelText('Password')).toBeRequired();
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    });

    it('completes the login form using only the keyboard', async () => {
      const user = userEvent.setup();
      renderLogin();
      await user.tab();
      expect(screen.getByLabelText('Email')).toHaveFocus();
      await user.keyboard('operator@example.com');
      await user.tab();
      expect(screen.getByLabelText('Password')).toHaveFocus();
      await user.keyboard('correct_password');
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(localStorage.getItem('adminToken')).toBe('fake_token');
      });
    });

    it('announces failed login errors via an alert', async () => {
      const user = userEvent.setup();
      renderLogin();
      await user.type(screen.getByLabelText('Email'), 'operator@example.com');
      await user.type(screen.getByLabelText('Password'), 'wrong_password');
      await user.click(screen.getByRole('button', { name: /sign in/i }));
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Invalid credentials');
      });
    });

    it('labels every FilterBar control on the users page', async () => {
      renderAdmin('/users');
      await waitForTable();
      expect(screen.getByLabelText('Phone')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
    });

    it('updates filter values from the transactions filter bar', async () => {
      renderAdmin('/transactions');
      await waitForTable();
      const statusSelect = screen.getByLabelText('Status');
      await userEvent.selectOptions(statusSelect, 'success');
      expect(statusSelect).toHaveValue('success');
      const phoneInput = screen.getByLabelText('User Phone');
      await userEvent.type(phoneInput, '+1');
      expect(phoneInput).toHaveValue('+1');
    });
  });

  describe('status indicators', () => {
    it('conveys badge status as text rather than color alone', () => {
      const { rerender } = render(<StatusBadge status="pending" />);
      expect(screen.getByText('pending')).toBeInTheDocument();
      rerender(<StatusBadge status="success" />);
      expect(screen.getByText('success')).toBeInTheDocument();
      rerender(<StatusBadge status="failed" />);
      expect(screen.getByText('failed')).toBeInTheDocument();
      rerender(<StatusBadge status={null} />);
      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });

    it('gives KYC row actions meaningful names and announces list loading', async () => {
      renderAdmin('/kyc');
      expect(screen.getByRole('status')).toBeInTheDocument();
      await waitForTable();
      expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /reject/i })).toBeEnabled();
      // The pending status is conveyed as text inside the table.
      const table = screen.getByRole('table');
      expect(within(table).getByText(/pending/i)).toBeInTheDocument();
    });

    it('announces audit log export errors via an alert', async () => {
      server.use(
        http.get('*/api/admin/audit-logs/export', () =>
          HttpResponse.json({ message: 'Export failed' }, { status: 403 })
        )
      );
      renderAdmin('/audit-logs');
      await waitForTable();
      await userEvent.click(screen.getByRole('button', { name: /export csv/i }));
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/failed to export audit logs/i);
      });
    });
  });

  describe('automated axe scans on real admin workflows', () => {
    it('has no detectable violations on the login page', async () => {
      const { container } = renderLogin();
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    }, 20000);

    it('has no detectable violations on the dashboard', async () => {
      const { container } = renderAdmin('/');
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Dashboard Overview' })).toBeInTheDocument();
      });
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    }, 20000);

    it('has no detectable violations on the users list', async () => {
      const { container } = renderAdmin('/users');
      await waitForTable();
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    }, 20000);

    it('has no detectable violations on the transactions list', async () => {
      const { container } = renderAdmin('/transactions');
      await waitForTable();
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    }, 20000);

    it('has no detectable violations on the KYC review workflow', async () => {
      const { container } = renderAdmin('/kyc');
      await waitForTable();
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    }, 20000);

    it('has no detectable violations on the audit logs workflow', async () => {
      const { container } = renderAdmin('/audit-logs');
      await waitForTable();
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    }, 20000);
  });
});
