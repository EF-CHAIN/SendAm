import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import api from '@shared/api';
import App from '../App.jsx';
import NotFound from '../pages/NotFound.jsx';
import {
  auditAxe,
  MANUAL_ONLY_SUCCESS_CRITERIA,
  findSuppressedFocusIndicators,
  recordAudit,
  resetAuditRecords,
  summariseAxeResults,
  flushAuditReport,
} from '@shared/a11yAudit';

/**
 * WCAG 2.2 AAA audit suite for the public landing app.
 *
 * Mirrors apps/admin/src/test/a11y-audit.test.jsx and shares its ruleset
 * (packages/shared/src/a11yAudit.js). Beyond the per-route axe scans it asserts
 * what a static scan cannot see: that the FAQ disclosure is wired to its panel
 * so expanded copy is announced, that landmarks are ordered for screen-reader
 * traversal, and that no control drops its focus indicator.
 *
 * Results are written to reports/a11y/landing.json for scripts/a11y-report.mjs.
 */

// The landing app has no MSW harness; OnboardingStatus is the only page that
// talks to the API, so the shared axios instance is stubbed instead. A 401
// makes the page fall back to its demo dataset, which is a real rendered state.
vi.mock('@shared/api', () => ({
  default: { get: vi.fn() },
}));

const DEMO_ONBOARDING = {
  stage: 'in_progress',
  percentComplete: 67,
  checkpoints: [
    { id: 'account_created', label: 'Account created', description: 'Registered.', complete: true },
    { id: 'wallet_ready', label: 'Wallet ready', description: 'Funded.', complete: true },
    { id: 'kyc_approved', label: 'Identity verified', description: 'Under review.', complete: false },
  ],
  nextStep: { action: 'await_review', message: 'Your identity verification is under review.' },
  blockers: [],
  kyc: { status: 'pending', tier: 0, sanctionsStatus: 'cleared' },
  wallet: { funded: true, fundingState: 'succeeded', trustlineState: 'succeeded', network: 'testnet' },
  accountActive: true,
  computedAt: '2026-01-05T10:00:00.000Z',
};

const UNAUTHORISED = Object.assign(new Error('Request failed with status code 401'), {
  response: { status: 401 },
});

const renderAt = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );

// Every route declared in App.jsx, including the catch-all.
const AUDITED_ROUTES = [
  { path: '/', ready: () => screen.findByRole('heading', { level: 1 }) },
  { path: '/onboarding', ready: () => screen.findByRole('heading', { name: /onboarding checkpoints/i }) },
  { path: '/no-such-landing-page', ready: () => screen.findByText(/404 - page not found/i) },
];

async function auditView({ route, state, container }) {
  const started = performance.now();
  const axeResults = await auditAxe(container);
  const summary = summariseAxeResults(axeResults);
  const focusOffenders = findSuppressedFocusIndicators(container);
  recordAudit({
    id: `landing:${route}:${state}`,
    app: 'landing',
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
  return { summary, focusOffenders };
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
  api.get.mockReset();
  api.get.mockRejectedValue(UNAUTHORISED);
});

afterAll(() => {
  flushAuditReport('landing', {
    routes: AUDITED_ROUTES.map((r) => r.path),
    manualOnlySuccessCriteria: MANUAL_ONLY_SUCCESS_CRITERIA,
  });
});

describe('landing WCAG 2.2 AAA audit', () => {
  describe('route coverage', () => {
    it('declares an audit target for every route in the app', () => {
      expect(AUDITED_ROUTES.length).toBe(3);
      expect(new Set(AUDITED_ROUTES.map((r) => r.path)).size).toBe(AUDITED_ROUTES.length);
    });

    it.each(AUDITED_ROUTES)('$path has no WCAG 2.2 A/AA/AAA violations', async ({ path, ready }) => {
      const { container } = renderAt(path);
      await ready();
      const { summary, focusOffenders } = await auditView({ route: path, state: 'loaded', container });
      expectClean(summary, focusOffenders, path);
    }, 30000);

    it('gives every route exactly one h1 and never skips a heading level', async () => {
      for (const { path, ready } of AUDITED_ROUTES) {
        const { unmount } = renderAt(path);
        await ready();
        const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)));
        expect(levels.filter((l) => l === 1), `${path} needs exactly one h1`).toHaveLength(1);
        expect(levels[0], `${path} must open with its h1`).toBe(1);
        for (let i = 1; i < levels.length; i++) {
          expect(levels[i], `${path} jumps from h${levels[i - 1]} to h${levels[i]}`).toBeLessThanOrEqual(levels[i - 1] + 1);
        }
        unmount();
      }
    });

    it('keeps the navigation/main/contentinfo landmarks in DOM order on every route', async () => {
      for (const { path, ready } of AUDITED_ROUTES) {
        const { container, unmount } = renderAt(path);
        await ready();
        const landmarks = Array.from(
          container.querySelectorAll('nav, main, footer')
        );
        expect(landmarks.map((l) => l.tagName.toLowerCase()), path).toEqual(['nav', 'main', 'footer']);
        // The landmark roles must be discoverable, not just structurally present.
        expect(screen.getByRole('navigation')).toBeInTheDocument();
        expect(screen.getByRole('main')).toBeInTheDocument();
        expect(screen.getByRole('contentinfo')).toBeInTheDocument();
        unmount();
      }
    });

    it('gives the navigation landmark an accessible name via aria-label or a heading', () => {
      const { container } = renderAt('/');
      const nav = container.querySelector('nav');
      // A single unnamed <nav> is fine; two would need disambiguation.
      expect(nav).toBeInTheDocument();
      expect(container.querySelectorAll('nav')).toHaveLength(1);
    });

    it('scans the onboarding page while its data is still loading', async () => {
      let resolveRequest;
      api.get.mockReturnValue(
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
      );
      const { container } = renderAt('/onboarding');
      // The shared Loader is a live status region, so the pending state is
      // announced rather than being a silent blank screen.
      await screen.findByRole('status');
      const { summary, focusOffenders } = await auditView({ route: '/onboarding', state: 'loading', container });
      expectClean(summary, focusOffenders, '/onboarding (loading)');

      resolveRequest({ data: { success: true, data: DEMO_ONBOARDING } });
      await screen.findByRole('heading', { name: /onboarding checkpoints/i });
    });

    it('scans the onboarding page error state', async () => {
      api.get.mockRejectedValue(
        Object.assign(new Error('network down'), { response: { status: 503 } })
      );
      const { container } = renderAt('/onboarding');
      // A failed load is announced, not just rendered.
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/unable to load onboarding status/i);
      const { summary, focusOffenders } = await auditView({ route: '/onboarding', state: 'error', container });
      expectClean(summary, focusOffenders, '/onboarding (error)');
    });
  });

  describe('dynamic content announcements', () => {
    it('associates each FAQ answer with its trigger so the expanded copy is announced', async () => {
      const user = userEvent.setup();
      renderAt('/');
      const trigger = await screen.findByRole('button', { name: /do users need to understand crypto/i });
      const panelId = trigger.getAttribute('aria-controls');
      expect(panelId, 'the FAQ trigger must point at its panel with aria-controls').toBeTruthy();
      // Collapsed: nothing expanded and panel hidden from assistive tech.
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(document.getElementById(panelId)).toHaveAttribute('aria-hidden', 'true');
      expect(document.getElementById(panelId)).toHaveAttribute('inert');

      await user.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');

      const panel = document.getElementById(panelId);
      expect(panel).toHaveAttribute('aria-hidden', 'false');
      expect(panel).not.toHaveAttribute('inert');
      // Labelled by the question, so a screen reader announces the answer in
      // the context of the question that revealed it.
      expect(panel).toHaveAttribute('role', 'region');
      expect(panel).toHaveAttribute('aria-labelledby', trigger.id);
      expect(trigger.id).toBeTruthy();
      expect(within(panel).getByText(/the blockchain rail is selected by sendam in the background/i)).toBeInTheDocument();
    });

    it('collapses the FAQ answer again and removes the panel', async () => {
      const user = userEvent.setup();
      renderAt('/');
      const trigger = await screen.findByRole('button', { name: /which blockchain does sendam use/i });
      const panelId = trigger.getAttribute('aria-controls');

      await user.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await user.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(document.getElementById(panelId)).toHaveAttribute('aria-hidden', 'true');
      expect(document.getElementById(panelId)).toHaveAttribute('inert');
    });

    it('operates the FAQ accordion with the keyboard alone', async () => {
      const user = userEvent.setup();
      renderAt('/');
      const trigger = await screen.findByRole('button', { name: /how are wallets managed/i });
      trigger.focus();
      expect(trigger).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await user.keyboard(' ');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('announces the onboarding progress percentage as readable text', async () => {
      renderAt('/onboarding');
      await screen.findByRole('heading', { name: /onboarding checkpoints/i });
      // Progress is never colour-only: the numeric value and stage word are
      // both present in the accessible tree.
      expect(screen.getByText(/67% of onboarding milestones completed/i)).toBeInTheDocument();
      expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    });

    it('distinguishes every checkpoint state by text, not just colour', async () => {
      renderAt('/onboarding');
      await screen.findByRole('heading', { name: /onboarding checkpoints/i });
      const statuses = screen.getAllByText(/^(Done|Pending|Blocked)$/);
      // 5 complete + 1 incomplete in the demo dataset.
      expect(statuses).toHaveLength(6);
      expect(screen.getAllByText('Done')).toHaveLength(5);
      expect(screen.getAllByText('Pending')).toHaveLength(1);
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

    it('reaches every navigation link in DOM order', async () => {
      const user = userEvent.setup();
      renderAt('/');
      const nav = screen.getByRole('navigation');
      // The wordmark is the first link in the bar.
      await user.tab();
      expect(within(nav).getByRole('link', { name: /sendam/i })).toHaveFocus();
      for (const name of [/features/i, /how it works/i, /faq/i, /onboarding/i]) {
        await user.tab();
        expect(within(nav).getByRole('link', { name })).toHaveFocus();
      }
      await user.tab();
      expect(within(nav).getByRole('link', { name: /open whatsapp|start/i })).toHaveFocus();
    });
  });

  describe('external links', () => {
    it('marks every new-tab link as noopener and names where it goes', async () => {
      for (const { path, ready } of AUDITED_ROUTES) {
        const { container, unmount } = renderAt(path);
        await ready();
        for (const link of container.querySelectorAll('a[target="_blank"]')) {
          const rel = (link.getAttribute('rel') || '').toLowerCase();
          expect(rel, `${path}: ${link.getAttribute('href')} opens a new tab without rel=noopener`).toContain('noopener');
        }
        unmount();
      }
    });

    it('gives the not-found page a single h1 and a way back home', () => {
      const { container } = render(
        <MemoryRouter>
          <NotFound />
        </MemoryRouter>
      );
      expect(within(container).getByRole('heading', { level: 1 })).toHaveTextContent(/404/i);
      expect(screen.getByRole('link', { name: /return home/i })).toHaveAttribute('href', '/');
    });
  });
});
