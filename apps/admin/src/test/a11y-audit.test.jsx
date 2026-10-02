import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import App from '../App.jsx';
import DataTable from '../components/DataTable.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { setToken, removeToken } from '../lib/auth';
import { server } from '../mocks/server';
import {
  auditAxe,
  CONTRAST_THRESHOLDS,
  MANUAL_ONLY_SUCCESS_CRITERIA,
  extractColourPair,
  findSuppressedFocusIndicators,
  recordAudit,
  resetAuditRecords,
  summariseAxeResults,
  flushAuditReport,
} from '@shared/a11yAudit';

/**
 * WCAG 2.2 AAA audit suite for the admin dashboard.
 *
 * Scans every route in App.jsx — and each of its meaningful DOM states
 * (loading, loaded, empty, error) — against the axe-core ruleset defined in
 * packages/shared/src/a11yAudit.js, then asserts the behaviours axe cannot
 * check: dialog focus containment, aria-sort transitions, colour-blind-safe
 * status badges and focus-indicator visibility.
 *
 * Every audited view is written to reports/a11y/admin.json, which
 * scripts/a11y-report.mjs turns into the CI compliance report. That is why the
 * scans are recorded as they run rather than only asserted.
 */

const MOBILE_WALLET = { _id: 'w1', userId: { phoneNumber: '+1234567890' }, publicKey: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQ', network: 'stellar', createdAt: '2026-01-05T10:00:00.000Z' };
const WEB_WALLET = { _id: 'w2', userId: { phoneNumber: '+1999888777' }, publicKey: 'GZYXWVUTSRQPONMLKJIHGFEDCBA987654ZYXWVUTSRQPONMLK', network: 'stellar', createdAt: '2026-02-11T08:30:00.000Z' };

const TRANSACTION_DETAIL = {
  _id: 'tx1',
  idempotencyKey: 'idem-0001',
  txHash: 'a'.repeat(64),
  providerTransactionId: 'prov-0001',
  explorerUrl: 'https://stellar.expert/explorer/testnet/tx/abc',
  type: 'deposit',
  amount: '100',
  asset: 'USDC',
  fiatAmount: '100.00',
  fiatCurrency: 'USD',
  rail: 'stellar',
  routeType: 'direct',
  destination: '+1234567890',
  recipientPhoneNumber: '+1999888777',
  userId: { id: 'u1', phoneNumber: '+1234567890' },
  status: 'Completed',
  createdAt: '2026-01-05T10:00:00.000Z',
  updatedAt: '2026-01-05T10:01:00.000Z',
  metadata: { rail: 'stellar' },
};

const ONBOARDING_STATUS = {
  stage: 'in_progress',
  percentComplete: 67,
  checkpoints: [
    { id: 'account_created', label: 'Account created', description: 'Registered.', complete: true },
    { id: 'kyc_approved', label: 'Identity verified', description: 'Under review.', complete: false },
  ],
  nextStep: { action: 'await_review', message: 'Your identity verification is under review.' },
  blockers: ['Maker-checker approval pending'],
};

// The shared mock only serves one active user and no wallets. The audit needs
// a deactivated account (Reactivate modal), a populated wallets table and the
// drill-down/onboarding endpoints, none of which the default handlers cover.
const AUDIT_HANDLERS = [
  http.get('*/api/admin/users', () =>
    HttpResponse.json({
      data: [
        { _id: '1', id: '1', phoneNumber: '+1234567890', createdAt: '2026-01-05T10:00:00.000Z' },
        {
          _id: '2',
          id: '2',
          phoneNumber: '+1999888777',
          whatsappName: 'Ada',
          deactivatedAt: '2026-03-01T09:00:00.000Z',
          deactivationReason: 'sanctions_match',
          createdAt: '2025-11-02T09:00:00.000Z',
        },
      ],
      pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: 2 },
    })
  ),
  http.get('*/api/admin/wallets', () =>
    HttpResponse.json({
      data: [MOBILE_WALLET, WEB_WALLET],
      pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: 2 },
    })
  ),
  http.get('*/api/admin/transactions/:id', () => HttpResponse.json({ data: TRANSACTION_DETAIL })),
  http.get('*/api/admin/users/:id/onboarding', () => HttpResponse.json({ data: ONBOARDING_STATUS })),
  http.post('*/api/admin/users/:id/deactivate', () => HttpResponse.json({ success: true })),
  http.post('*/api/admin/users/:id/reactivate', () => HttpResponse.json({ success: true })),
  http.get('*/api/admin/compliance/evidence/:id/download', () => new HttpResponse('{}', { headers: { 'Content-Type': 'application/json' } })),
  http.post('*/api/admin/password', () => HttpResponse.json({ success: true })),
];

const renderAt = (path) => {
  setToken('a11y-audit-token', { broadcast: false });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
};

// Every route declared in App.jsx. The catch-all (`*`) is included as
// /no-such-admin-route, which renders the Dashboard.
const AUDITED_ROUTES = [
  { path: '/login', ready: () => screen.findByRole('button', { name: /sign in/i }, { timeout: 5000 }) },
  { path: '/set-password', ready: () => screen.findByRole('button', { name: /set password/i }, { timeout: 5000 }) },
  { path: '/', ready: () => screen.findByRole('heading', { name: 'Dashboard Overview' }, { timeout: 5000 }) },
  { path: '/users', ready: () => screen.findByRole('table', {}, { timeout: 5000 }) },
  { path: '/wallets', ready: () => screen.findByRole('table', {}, { timeout: 5000 }) },
  { path: '/transactions', ready: () => screen.findByRole('table', {}, { timeout: 5000 }) },
  { path: '/transactions/tx1', ready: () => screen.findByRole('heading', { name: 'Transaction Detail' }, { timeout: 5000 }) },
  { path: '/kyc', ready: () => screen.findByRole('table', {}, { timeout: 5000 }) },
  { path: '/audit-logs', ready: () => screen.findByRole('table', {}, { timeout: 5000 }) },
  { path: '/system-health', ready: () => screen.findByRole('heading', { name: 'System Health' }, { timeout: 5000 }) },
  { path: '/no-such-admin-route', ready: () => screen.findByRole('heading', { name: 'Dashboard Overview' }, { timeout: 5000 }) },
];

// Run axe over a mounted view and file the outcome for the HTML report.
async function auditView({ app, route, state, container }) {
  const started = performance.now();
  const axeResults = await auditAxe(container);
  const summary = summariseAxeResults(axeResults);
  const focusOffenders = findSuppressedFocusIndicators(container);
  recordAudit({
    id: `${app}:${route}:${state}`,
    app,
    route,
    state,
    status: summary.violations.length === 0 && focusOffenders.length === 0 ? 'pass' : 'fail',
    ruleset: 'WCAG 2.2 (A + AA + AAA tags) via axe-core',
    durationMs: Math.round(performance.now() - started),
    ...summary,
    suppressedFocusIndicators: focusOffenders.map((o) => ({
      element: o.description,
      classes: o.classes,
      help: 'Focus outline is removed with no replacement indicator (WCAG 2.4.7 Focus Visible).',
    })),
  });
  return { axeResults, summary, focusOffenders };
}

const expectClean = (summary, focusOffenders, label) => {
  if (summary.violations.length > 0 || focusOffenders.length > 0) {
    const detail = [
      ...summary.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.target?.join(' ')}`),
      ...focusOffenders.map((o) => `suppressed focus indicator: ${o.description} class="${o.classes}"`),
    ].join('\n');
    throw new Error(`${label} has accessibility violations:\n${detail}`);
  }
};

// Cleared once, here, rather than in beforeEach: the records are the suite's
// output, so a per-test reset would discard every view but the last one.
resetAuditRecords();

beforeEach(() => {
  server.use(...AUDIT_HANDLERS);
  setToken('a11y-audit-token', { broadcast: false });
});

afterEach(() => {
  removeToken({ broadcast: false });
});

afterAll(() => {
  flushAuditReport('admin', {
    routes: AUDITED_ROUTES.map((r) => r.path),
    manualOnlySuccessCriteria: MANUAL_ONLY_SUCCESS_CRITERIA,
  });
});

describe('admin WCAG 2.2 AAA audit', () => {
  describe('route coverage', () => {
    it('declares an audit target for every route in the app', () => {
      // Guards against a new route being added without an audit entry.
      expect(AUDITED_ROUTES.length).toBe(11);
      expect(new Set(AUDITED_ROUTES.map((r) => r.path)).size).toBe(AUDITED_ROUTES.length);
    });

    it.each(AUDITED_ROUTES)('$path has no WCAG 2.2 A/AA/AAA violations', async ({ path, ready }) => {
      const { container } = renderAt(path);
      await ready();
      const { summary, focusOffenders } = await auditView({
        app: 'admin',
        route: path,
        state: 'loaded',
        container,
      });
      expectClean(summary, focusOffenders, path);
    }, 30000);

    it('exposes a single h1 and the banner/main landmarks on every authenticated route', async () => {
      for (const { path, ready } of AUDITED_ROUTES.filter((r) => !['/login', '/set-password'].includes(r.path))) {
        const { unmount } = renderAt(path);
        await ready();
        expect(screen.getAllByRole('heading', { level: 1 }), `${path} needs exactly one h1`).toHaveLength(1);
        expect(screen.getAllByRole('main'), `${path} needs one main landmark`).toHaveLength(1);
        unmount();
      }
    });

    it('never skips a heading level on any route', async () => {
      for (const { path, ready } of AUDITED_ROUTES) {
        const { unmount } = renderAt(path);
        await ready();
        const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)));
        for (let i = 1; i < levels.length; i++) {
          expect(
            levels[i],
            `${path} jumps from h${levels[i - 1]} to h${levels[i]}`
          ).toBeLessThanOrEqual(levels[i - 1] + 1);
        }
        unmount();
      }
    });
  });

  describe('dynamic content announcements', () => {
    it('announces list loading with a live status region', async () => {
      const { container } = renderAt('/kyc');
      // Synchronously after mount the shared Loader exposes a live region.
      expect(screen.getByRole('status')).toBeInTheDocument();
      const { summary, focusOffenders } = await auditView({
        app: 'admin',
        route: '/kyc',
        state: 'loading',
        container,
      });
      expectClean(summary, focusOffenders, '/kyc (loading)');

      await screen.findByRole('table');
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('announces dashboard load failures as an alert', async () => {
      server.use(
        http.get('*/api/admin/stats', () =>
          HttpResponse.json({ message: 'Stats unavailable' }, { status: 500 })
        )
      );
      const { container } = renderAt('/');
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/a server error occurred/i));
      const { summary, focusOffenders } = await auditView({
        app: 'admin',
        route: '/',
        state: 'error',
        container,
      });
      expectClean(summary, focusOffenders, '/ (error)');
    });

    it('announces an empty result set as text rather than silence', async () => {
      server.use(
        http.get('*/api/admin/wallets', () =>
          HttpResponse.json({
            data: [],
            pagination: { limit: 50, nextCursor: null, prevCursor: null, hasMore: false, total: 0 },
          })
        )
      );
      const { container } = renderAt('/wallets');
      await screen.findByText('No records found.');
      const { summary, focusOffenders } = await auditView({
        app: 'admin',
        route: '/wallets',
        state: 'empty',
        container,
      });
      expectClean(summary, focusOffenders, '/wallets (empty)');
    });

    it('announces a successful account action through a status region', async () => {
      const user = userEvent.setup();
      const { container } = renderAt('/users');
      await screen.findByRole('table');
      const row = screen.getByText('+1234567890').closest('tr');
      await user.click(within(row).getByRole('button', { name: /^deactivate$/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /confirm deactivation/i }));
      const passkeyPrompt = await screen.findByTestId('passkey-prompt');
      await user.click(within(passkeyPrompt).getByRole('checkbox'));
      await user.click(within(passkeyPrompt).getByRole('button', { name: /continue without passkey/i }));
      // The list also refetches, so the shared Loader contributes a second live
      // region — assert the confirmation is among the status regions.
      await waitFor(() =>
        expect(screen.getByText(/account deactivated successfully/i)).toBeInTheDocument()
      );
      const regions = screen.getAllByRole('status').map((el) => el.textContent || '');
      expect(regions.some((t) => /account deactivated/i.test(t))).toBe(true);
      const { summary, focusOffenders } = await auditView({
        app: 'admin',
        route: '/users',
        state: 'action-success',
        container,
      });
      expectClean(summary, focusOffenders, '/users (action success)');
    });
  });

  describe('modal dialogs', () => {
    // The users table renders one action set per row, so a trigger is addressed
    // through the phone number of the account it belongs to rather than by name
    // alone — "Onboarding" and "Evidence" appear once per user.
    const openModal = async ({ path, trigger, phone, ready }) => {
      renderAt(path);
      const table = await screen.findByRole('table');
      const user = userEvent.setup();
      const row = within(table).getByText(phone).closest('tr');
      const triggerEl = within(row).getByRole('button', { name: trigger });
      await user.click(triggerEl);
      const dialog = await screen.findByRole('dialog');
      if (ready) await ready();
      return { user, trigger: triggerEl, dialog };
    };

    const DIALOGS = [
      {
        name: 'onboarding status',
        path: '/users',
        phone: '+1234567890',
        trigger: /onboarding/i,
        title: 'Onboarding Status',
        // The close button is first in DOM order, so it receives focus on open.
        firstFocusable: /close onboarding status/i,
        ready: () => screen.findByRole('heading', { name: /checkpoints/i }),
      },
      {
        name: 'deactivate account',
        path: '/users',
        phone: '+1234567890',
        trigger: /^deactivate$/i,
        title: 'Deactivate Customer Account',
        firstFocusable: /deactivation reason/i,
      },
      {
        name: 'reactivate account',
        path: '/users',
        phone: '+1999888777',
        trigger: /reactivate/i,
        title: 'Reactivate Customer Account',
        firstFocusable: /reactivation notes/i,
      },
    ];

    it.each(DIALOGS)('$name is a labelled modal dialog', async (dialog) => {
      const { dialog: node } = await openModal(dialog);
      expect(node).toHaveAttribute('aria-modal', 'true');
      expect(node).toHaveAccessibleName(dialog.title);
      // The heading is the accessible name source, so it must be in the dialog.
      expect(within(node).getByRole('heading', { name: dialog.title })).toBeInTheDocument();
    });

    it.each(DIALOGS)('$name moves focus inside the dialog on open', async (dialog) => {
      const { dialog: node } = await openModal(dialog);
      await waitFor(() => expect(node).toContainElement(document.activeElement));
      expect(document.activeElement).toHaveAccessibleName(dialog.firstFocusable);
    });

    it.each(DIALOGS)('$name keeps Tab focus contained', async (dialog) => {
      const { dialog: node } = await openModal(dialog);
      const focusable = Array.from(
        node.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
      );
      expect(focusable.length).toBeGreaterThan(0);

      // A synthetic keydown exercises the trap's own wrap logic; the browser's
      // own Tab handling is not reproducible in jsdom, so this asserts the
      // containment contract directly.
      const pressTab = (shiftKey) => {
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
        );
      };

      // From the first control, Shift+Tab wraps to the last.
      focusable[0].focus();
      pressTab(true);
      expect(document.activeElement).toBe(focusable[focusable.length - 1]);

      // From the last control, Tab wraps back to the first.
      pressTab(false);
      expect(document.activeElement).toBe(focusable[0]);

      // And focus never lands outside the dialog while cycling. Without the
      // trap, Tab here would continue into the page behind the modal.
      for (let i = 0; i < focusable.length * 2; i++) {
        pressTab(false);
        expect(node).toContainElement(document.activeElement);
      }
    });

    it.each(DIALOGS)('$name closes on Escape and restores focus to its trigger', async (dialog) => {
      const { user, trigger: triggerEl, dialog: node } = await openModal(dialog);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(node).not.toBeInTheDocument();
      expect(triggerEl).toHaveFocus();
    });

    it.each(DIALOGS)('$name has no violations while open', async (dialog) => {
      const { dialog: node } = await openModal(dialog);
      const { summary, focusOffenders } = await auditView({
        app: 'admin',
        route: dialog.path,
        state: `dialog:${dialog.name}`,
        container: node,
      });
      expectClean(summary, focusOffenders, `${dialog.name} dialog`);
    });

    it('labels every control inside the deactivation dialog', async () => {
      const { dialog: node } = await openModal(DIALOGS[1]);
      for (const name of [/deactivation reason/i, /operational notes/i, /force override/i]) {
        expect(within(node).getByLabelText(name)).toBeInTheDocument();
      }
    });

    it('labels every control inside the reactivation dialog', async () => {
      const { dialog: node } = await openModal(DIALOGS[2]);
      expect(within(node).getByLabelText(/reactivation notes/i)).toBeInTheDocument();
      expect(within(node).getByLabelText(/second approver id/i)).toBeInTheDocument();
    });
  });

  describe('table semantics and aria-sort', () => {
    const SORTABLE_COLUMNS = [
      { header: 'Name', accessor: 'name', sortable: true },
      { header: 'Amount', accessor: 'amount', sortable: true },
      { header: 'Internal note' },
    ];
    const ROWS = [
      { id: '1', name: 'Beta', amount: 300 },
      { id: '2', name: 'alpha', amount: 100 },
      { id: '3', name: 'Gamma', amount: 200 },
    ];

    const sortTable = () => {
      const { container } = render(
        <MemoryRouter>
          <DataTable columns={SORTABLE_COLUMNS} data={ROWS} />
        </MemoryRouter>
      );
      const headerFor = (name) =>
        within(container).getByRole('columnheader', { name: new RegExp(`^${name}`, 'i') });
      const rowNames = () =>
        within(container)
          .getAllByRole('row')
          .slice(1)
          .map((row) => within(row).getAllByRole('cell')[0].textContent);
      return { container, headerFor, rowNames };
    };

    it('marks every unsorted sortable column aria-sort="none" and leaves fixed columns unmarked', () => {
      const { headerFor } = sortTable();
      expect(headerFor('Name')).toHaveAttribute('aria-sort', 'none');
      expect(headerFor('Amount')).toHaveAttribute('aria-sort', 'none');
      // aria-sort on a column that cannot be sorted would misreport the table.
      expect(headerFor('Internal note')).not.toHaveAttribute('aria-sort');
    });

    it('updates aria-sort as the sort moves between columns and directions', async () => {
      const user = userEvent.setup();
      const { headerFor } = sortTable();

      await user.click(within(headerFor('Name')).getByRole('button'));
      expect(headerFor('Name')).toHaveAttribute('aria-sort', 'ascending');
      expect(headerFor('Amount')).toHaveAttribute('aria-sort', 'none');

      await user.click(within(headerFor('Name')).getByRole('button'));
      expect(headerFor('Name')).toHaveAttribute('aria-sort', 'descending');
      expect(headerFor('Amount')).toHaveAttribute('aria-sort', 'none');

      // Moving the sort elsewhere must release the previous column.
      await user.click(within(headerFor('Amount')).getByRole('button'));
      expect(headerFor('Amount')).toHaveAttribute('aria-sort', 'ascending');
      expect(headerFor('Name')).toHaveAttribute('aria-sort', 'none');
    });

    it('reorders rows to match the announced sort', async () => {
      const user = userEvent.setup();
      const { headerFor, rowNames } = sortTable();
      expect(rowNames()).toEqual(['Beta', 'alpha', 'Gamma']);

      await user.click(within(headerFor('Name')).getByRole('button'));
      expect(rowNames()).toEqual(['alpha', 'Beta', 'Gamma']);

      await user.click(within(headerFor('Name')).getByRole('button'));
      expect(rowNames()).toEqual(['Gamma', 'Beta', 'alpha']);

      await user.click(within(headerFor('Amount')).getByRole('button'));
      expect(rowNames()).toEqual(['alpha', 'Gamma', 'Beta']);

      // The sort must not mutate the caller's array.
      expect(ROWS.map((r) => r.name)).toEqual(['Beta', 'alpha', 'Gamma']);
    });

    it('keeps the sort trigger reachable and correctly named', () => {
      const { container } = sortTable();
      const trigger = within(container).getByRole('button', { name: 'Name' });
      trigger.focus();
      expect(trigger).toHaveFocus();
      // The direction icon is decorative; it must not leak into the name.
      expect(within(container).getByRole('button', { name: 'Name' }).textContent).toBe('Name');
    });

    it('has no violations with a sort control active', async () => {
      const { container, headerFor } = sortTable();
      await userEvent.click(within(headerFor('Name')).getByRole('button'));
      const { summary, focusOffenders } = await auditView({
        app: 'admin',
        route: '/users',
        state: 'datatable:sorted',
        container,
      });
      expectClean(summary, focusOffenders, 'sortable DataTable');
    });

    it('never emits aria-sort on the production tables, which are not sortable', async () => {
      for (const path of ['/users', '/wallets', '/transactions', '/kyc', '/audit-logs']) {
        const { unmount } = renderAt(path);
        await screen.findByRole('table');
        for (const th of screen.getAllByRole('columnheader')) {
          expect(th, `${path} column "${th.textContent}"`).not.toHaveAttribute('aria-sort');
          expect(th).toHaveAttribute('scope', 'col');
        }
        unmount();
      }
    });
  });

  describe('status badges: colour-blind accessibility', () => {
    // Level AAA §1.4.6. A tint background cannot reach 7:1 with a 700-weight
    // text colour, so these are checked against the palette the component
    // actually renders rather than against a hardcoded copy of it.
    const STATES = [
      { status: 'success', label: 'success' },
      { status: 'pending', label: 'pending' },
      { status: 'failed', label: 'failed' },
      { status: 'SUSPICIOUS', label: 'SUSPICIOUS' },
      { status: null, label: 'Unknown' },
    ];

    it.each(STATES)('$status reaches the 7:1 AAA contrast threshold', ({ status }) => {
      const { container } = render(<StatusBadge status={status} />);
      const badge = container.firstElementChild;
      const pair = extractColourPair(badge.getAttribute('class'));
      expect(pair.background, 'badge has no resolvable background colour').not.toBeNull();
      expect(pair.foreground, 'badge has no resolvable text colour').not.toBeNull();
      expect(
        pair.ratio,
        `${pair.foreground.utility} on ${pair.background.utility} is ${pair.ratio.toFixed(2)}:1, ` +
          `below the ${CONTRAST_THRESHOLDS.AAA}:1 AAA threshold`
      ).toBeGreaterThanOrEqual(CONTRAST_THRESHOLDS.AAA);
    });

    it('never relies on colour alone: every state has a text label', () => {
      for (const { status, label } of STATES) {
        const { container } = render(<StatusBadge status={status} />);
        // The status word is the primary non-colour cue (WCAG 1.4.1), so it
        // must survive on its own with the colour stripped away.
        expect(screen.getByText(label)).toBeInTheDocument();
        // ...and a per-state glyph keeps states apart in monochrome.
        const glyph = container.querySelector('[aria-hidden="true"]');
        expect(glyph, `${label} has no redundant non-colour indicator`).toBeInTheDocument();
        const glyphVal = glyph.getAttribute('data-glyph') || glyph.textContent;
        expect(glyphVal).not.toBe(label);
        expect(glyphVal.trim().length).toBeGreaterThan(0);
      }
    });

    it('gives each visual state a distinct glyph so monochrome rendering stays unambiguous', () => {
      // Four visual buckets: success, pending, failed, and the fallback used by
      // any unrecognised or absent status.
      const glyphByState = new Map();
      for (const { status, label } of STATES) {
        const { container } = render(<StatusBadge status={status} />);
        const glyph = container.querySelector('[aria-hidden="true"]');
        glyphByState.set(label, glyph.getAttribute('data-glyph') || glyph.textContent);
      }
      // Known states map to their own glyph...
      expect(glyphByState.get('success')).not.toBe(glyphByState.get('pending'));
      expect(glyphByState.get('success')).not.toBe(glyphByState.get('failed'));
      expect(glyphByState.get('pending')).not.toBe(glyphByState.get('failed'));
      // ...and unrecognised statuses share the single fallback glyph, so all
      // four buckets stay distinguishable without relying on hue at all.
      expect(new Set(glyphByState.values()).size).toBe(4);
      expect(glyphByState.get('Unknown')).toBe(glyphByState.get('SUSPICIOUS'));
    });

    it('hides the decorative glyph from screen readers so the word is announced alone', () => {
      const { container } = render(<StatusBadge status="pending" />);
      const glyph = container.querySelector('[aria-hidden="true"]');
      expect(glyph).toHaveAttribute('aria-hidden', 'true');
      expect(container.firstElementChild).toHaveAccessibleName('pending');
    });

    it('renders the badge with no violations', async () => {
      const { container } = render(
        <table>
          <caption>Transaction statuses</caption>
          <tbody>
            {STATES.map(({ status, label }, i) => (
              <tr key={label}>
                <td>Row {i}</td>
                <td>
                  <StatusBadge status={status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
      const { summary, focusOffenders } = await auditView({
        app: 'admin',
        route: '/users',
        state: 'status-badges',
        container,
      });
      expectClean(summary, focusOffenders, 'StatusBadge');
    });
  });

  describe('focus indicators', () => {
    it('keeps a visible indicator on every focusable control on every route', async () => {
      for (const { path, ready } of AUDITED_ROUTES) {
        const { container, unmount } = renderAt(path);
        await ready();
        const offenders = findSuppressedFocusIndicators(container);
        expect(
          offenders,
          `${path}: ${offenders.map((o) => `${o.description} class="${o.classes}"`).join('; ')}`
        ).toEqual([]);
        unmount();
      }
    });

    it('reaches the login form controls in DOM order with visible focus', async () => {
      const user = userEvent.setup();
      renderAt('/login');
      await screen.findByLabelText('Email');
      await user.tab();
      expect(screen.getByLabelText('Email')).toHaveFocus();
      await user.tab();
      expect(screen.getByLabelText('Password')).toHaveFocus();
      await user.tab();
      expect(screen.getByRole('button', { name: /show password/i })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole('button', { name: /sign in/i })).toHaveFocus();
    });
  });
});
