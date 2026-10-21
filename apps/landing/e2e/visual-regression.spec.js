import { test, expect } from '@playwright/test';

test.describe('Landing App - Visual Regression Suite', () => {
  // Root config starts both dev servers; point relative goto() at this app's.
  test.use({ baseURL: 'http://localhost:5173' });

  test.beforeEach(async ({ page }) => {
    // Wait until fonts and critical assets are loaded
    await page.addInitScript(() => {
      window.__VISUAL_TESTING__ = true;
    });
  });

  test('Home page pixel baseline across viewports', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Hide volatile dynamic elements if any (e.g. timestamps, animated badges)
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }
      `,
    });

    await expect(page).toHaveScreenshot('landing-home.png', {
      maxDiffPixelRatio: 0.002, // 0.2% tolerance
      fullPage: true,
    });
  });

  test('Onboarding status page visual snapshot', async ({ page }) => {
    await page.goto('/status?ref=demo_123');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveScreenshot('landing-onboarding-status.png', {
      maxDiffPixelRatio: 0.002,
      fullPage: true,
    });
  });

  test('404 / NotFound page visual snapshot', async ({ page }) => {
    await page.goto('/non-existent-route-for-testing');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveScreenshot('landing-not-found.png', {
      maxDiffPixelRatio: 0.002,
      fullPage: true,
    });
  });
});
