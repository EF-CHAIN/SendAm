import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from './App.jsx';
import StatusBadge from './components/StatusBadge.jsx';
import DataTable from './components/DataTable.jsx';
import FilterBar from './components/FilterBar.jsx';
import KycExportModal from './components/KycExportModal.jsx';
import PasskeyPromptModal from './components/PasskeyPromptModal.jsx';
import { setToken, removeToken } from './lib/auth';
import { axe, axeWcag21AA } from './test/axe';
import { server } from './mocks/server';
import { http, HttpResponse } from 'msw';

// Accessibility coverage for the critical admin dashboard workflows:
// navigation, tables, pagination, forms, status indicators, keyboard
// operation and axe scans of the real rendered routes. Runs in CI via
// `npm run test --workspace=apps/admin` (see .github/workflows/test.yml).
//
// Component-level axe audits at the end of this file run the WCAG 2.1 A/AA
// ruleset (see `axeWcag21AA` in ./test/axe.js) against DataTable, FilterBar
// and the KYC review dialogs, and prove the audit itself fails on missing
// labels and ARIA role mismatches.

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

    it('gives every sidebar link and the logout button a meaningful accessible name', async () => {
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
        const link = await screen.findByRole('link', { name });
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
        expect(screen.getByRole('alert')).toHaveTextContent(/a server error occurred/i);
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
        'ID / Hash', 'User Phone', 'Type', 'Amount', 'Rail', 'Destination', 'Receipt', 'Status', 'Date',
      ]);
      for (const th of headers) {
        expect(th).toHaveAttribute('scope', 'col');
      }
      // Header row + at least one data row.
      await waitFor(() => {
        expect(within(screen.getByRole('table')).getAllByRole('row').length).toBeGreaterThanOrEqual(2);
      });
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
    it('associates login labels with their controls and marks them required', async () => {
      renderLogin();
      expect(await screen.findByLabelText('Email')).toBeRequired();
      expect(screen.getByLabelText('Password')).toBeRequired();
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    });

    it('completes the login form using only the keyboard', async () => {
      const user = userEvent.setup();
      renderLogin();
      await screen.findByLabelText('Email');
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

  describe('component axe audits (WCAG 2.1 AA)', () => {
    const COLUMNS = [
      { header: 'Phone', accessor: 'phone', sortable: true },
      { header: 'Amount', accessor: 'amount', sortable: true },
      { header: 'Status', accessor: 'status', render: (row) => <StatusBadge status={row.status} /> },
    ];
    const ROWS = [
      { id: 'r1', phone: '+2348000000001', amount: 120, status: 'success' },
      { id: 'r2', phone: '+2348000000002', amount: 45, status: 'pending' },
      { id: 'r3', phone: '+2348000000003', amount: 300, status: 'failed' },
    ];
    const FIELDS = [
      { key: 'phone', label: 'Phone', placeholder: '+234...' },
      { key: 'status', label: 'Status', type: 'select', options: ['pending', 'success', 'failed'] },
      { key: 'from', label: 'From date', type: 'date' },
    ];

    const expectNoWcagViolations = async (container) => {
      const results = await axeWcag21AA(container);
      expect(results).toHaveNoViolations();
      return results;
    };

    const renderTable = (props, path = '/') =>
      render(
        <MemoryRouter initialEntries={[path]}>
          <DataTable caption="Synthetic transactions" columns={COLUMNS} data={ROWS} {...props} />
        </MemoryRouter>
      );

    it('audits a sortable, clickable DataTable before and after sorting', async () => {
      const { container } = renderTable({ onRowClick: () => {} });
      await expectNoWcagViolations(container);
      await userEvent.click(screen.getByRole('button', { name: /amount/i }));
      expect(screen.getByRole('columnheader', { name: /amount/i })).toHaveAttribute('aria-sort', 'ascending');
      await expectNoWcagViolations(container);
    }, 20000);

    it('audits the DataTable empty state with and without active filters', async () => {
      const unfiltered = renderTable({ data: [] });
      expect(screen.getByRole('region', { name: /empty state/i })).toBeInTheDocument();
      await expectNoWcagViolations(unfiltered.container);
      unfiltered.unmount();

      const filtered = renderTable({ data: [] }, '/?status=failed');
      expect(screen.getByRole('button', { name: /reset filters/i })).toBeInTheDocument();
      await expectNoWcagViolations(filtered.container);
    }, 20000);

    it('audits a virtualised DataTable with a focusable scroll region', async () => {
      const many = Array.from({ length: 60 }, (_, index) => ({
        id: `v${index}`,
        phone: `+23480000${String(index).padStart(5, '0')}`,
        amount: index,
        status: 'success',
      }));
      const { container } = renderTable({ data: many, maxHeight: 300 });
      const region = screen.getByRole('region', { name: /scrollable view/i });
      expect(region).toHaveAttribute('tabindex', '0');
      await expectNoWcagViolations(container);
    }, 20000);

    it('audits FilterBar with empty values and with active filter chips', async () => {
      const values = { phone: '', status: '', from: '' };
      const props = {
        fields: FIELDS,
        getFilter: (key) => values[key],
        setFilter: () => {},
        onReset: () => {},
      };
      const empty = render(<FilterBar {...props} />);
      for (const field of FIELDS) {
        expect(screen.getByLabelText(field.label)).toBeInTheDocument();
      }
      await expectNoWcagViolations(empty.container);
      empty.unmount();

      values.phone = '+234';
      values.status = 'failed';
      const active = render(<FilterBar {...props} />);
      expect(screen.getByRole('list', { name: /active filters/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /clear phone filter/i })).toBeInTheDocument();
      await expectNoWcagViolations(active.container);
    }, 20000);

    it('audits the KYC approve and reject confirmation dialogs', async () => {
      const { container } = renderAdmin('/kyc');
      await waitForTable();
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: /approve/i }));
      expect(screen.getByRole('dialog', { name: 'Approve KYC' })).toHaveAttribute('aria-modal', 'true');
      await expectNoWcagViolations(container);
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await user.click(screen.getByRole('button', { name: /reject/i }));
      const dialog = screen.getByRole('dialog', { name: 'Reject KYC' });
      expect(within(dialog).getByLabelText(/rejection reason/i)).toBeRequired();
      await expectNoWcagViolations(container);
    }, 20000);

    it('audits the KYC export dialog', async () => {
      const { container } = render(
        <KycExportModal isOpen onClose={() => {}} onExport={() => {}} exporting={false} />
      );
      expect(screen.getByRole('dialog', { name: /export kyc data/i })).toBeInTheDocument();
      await expectNoWcagViolations(container);
    }, 20000);

    it('audits the passkey step-up dialog used by KYC review actions', async () => {
      for (const action of ['kyc.approve', 'kyc.reject']) {
        const { container, unmount } = render(
          <PasskeyPromptModal
            open
            action={action}
            support={{ supported: true, platformAuthenticator: true, checked: true }}
            onVerify={() => {}}
            onFallback={() => {}}
            onCancel={() => {}}
          />
        );
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        await expectNoWcagViolations(container);
        unmount();
      }
    }, 20000);

    it('fails the audit when a control has no label', async () => {
      const { container } = render(
        <form>
          <input type="text" />
          <select>
            <option>One</option>
          </select>
        </form>
      );
      const results = await axeWcag21AA(container);
      const ids = results.violations.map((violation) => violation.id);
      expect(ids).toContain('label');
      expect(ids).toContain('select-name');
      expect(() => expect(results).toHaveNoViolations()).toThrow();
    });

    it('fails the audit on ARIA role mismatches', async () => {
      const { container } = render(
        <div>
          <div role="row">
            <span role="cell">Orphaned cell</span>
          </div>
          <span role="buton">Not a role</span>
          <div role="list">
            <span>Not a list item</span>
          </div>
        </div>
      );
      const results = await axeWcag21AA(container);
      const ids = results.violations.map((violation) => violation.id);
      expect(ids).toContain('aria-required-parent');
      expect(ids).toContain('aria-roles');
      expect(ids).toContain('aria-required-children');
    });
  });
});
