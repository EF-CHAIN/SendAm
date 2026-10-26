import { test, expect } from '@playwright/test';

// Pixel-diff suite for the landing page (#826). The root playwright.config.js
// runs it under three profiles: landing-desktop-chrome, landing-ipad-mini and
// landing-iphone-14. The diff tolerance comes from VISUAL_MAX_DIFF_PIXEL_RATIO
// (default 0.05%, always below 0.1%); see apps/landing/build/visualThreshold.js.
// On failure Playwright writes expected/actual/diff PNGs to test-results/ and
// the HTML report, which CI uploads as the playwright-visual-diffs artifact.

const ONBOARDING_STATUS = {
  success: true,
  data: {
    stage: 'in_progress',
    percentComplete: 67,
    checkpoints: [
      { id: 'account_created', label: 'Account created', description: 'Your WhatsApp account is registered.', complete: true },
      { id: 'wallet_ready', label: 'Wallet ready', description: 'Your Stellar wallet is ready.', complete: true },
      { id: 'kyc_approved', label: 'Identity verified', description: 'Verification is under review.', complete: false },
    ],
    nextStep: { action: 'await_review', message: 'Your identity verification is under review.' },
    blockers: [],
    kyc: { status: 'pending', tier: 0, sanctionsStatus: 'cleared' },
    wallet: { funded: true, fundingState: 'succeeded', trustlineState: 'succeeded', network: 'testnet' },
    accountActive: true,
    computedAt: '2026-01-01T00:00:00.000Z',
  },
};

const FREEZE_MOTION = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const PAGES = [
  { name: 'landing-home', path: '/' },
  { name: 'landing-onboarding-status', path: '/onboarding' },
  { name: 'landing-not-found', path: '/non-existent-route-for-testing' },
];

test.describe('Landing App - Visual Regression Suite', () => {
  // Root config starts both dev servers; point relative goto() at this app's.
  test.use({
    baseURL: 'http://localhost:5173',
    locale: 'en-US',
    timezoneId: 'UTC',
    // CorridorGlobe stops its animation loop under reduced motion.
    reducedMotion: 'reduce',
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.__VISUAL_TESTING__ = true;
    });
    // Remote fonts make pixels depend on network timing; render with the
    // fallback stack so every run uses the same glyphs.
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await page.route('**/api/compliance/onboarding', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ONBOARDING_STATUS) }),
    );
  });

  const settle = async (page, path) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await page.addStyleTag({ content: FREEZE_MOTION });
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
    });
  };

  for (const { name, path } of PAGES) {
    test(`${name} matches its baseline`, async ({ page }) => {
      await settle(page, path);
      await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
    });

    test(`${name} has no horizontal overflow`, async ({ page }) => {
      await settle(page, path);
      const overflow = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const offenders = [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().right - viewport > 1)
          .filter((el) => getComputedStyle(el).position !== 'fixed')
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')}`);
        return { scrollWidth: document.documentElement.scrollWidth, viewport, offenders };
      });
      expect(overflow.scrollWidth, `wider than the viewport: ${overflow.offenders.join(', ')}`).toBeLessThanOrEqual(
        overflow.viewport,
      );
    });
  }
});
