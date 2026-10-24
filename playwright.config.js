import { defineConfig, devices } from '@playwright/test';
import { resolveMaxDiffPixelRatio } from './apps/landing/build/visualThreshold.js';

const LANDING_SPEC = '**/apps/landing/e2e/visual-regression.spec.js';
const ADMIN_SPEC = '**/apps/admin/e2e/visual-regression.spec.js';
const landingMaxDiffPixelRatio = resolveMaxDiffPixelRatio();

/**
 * Playwright Configuration for Automated Visual Regression Testing Pipeline.
 * Closes #589.
 */
export default defineConfig({
  testDir: './',
  testMatch: [LANDING_SPEC, ADMIN_SPEC],
  timeout: 30 * 1000,
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.002, // 0.2% max difference tolerance
      threshold: 0.2,
      animations: 'disabled',
    },
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Admin keeps its existing viewport set and baselines.
    {
      name: 'desktop',
      testMatch: ADMIN_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'tablet',
      testMatch: ADMIN_SPEC,
      use: {
        ...devices['iPad Mini'],
        // CI installs Chromium only; keep the iPad viewport/touch profile but not WebKit.
        defaultBrowserType: 'chromium',
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: 'mobile',
      testMatch: ADMIN_SPEC,
      use: {
        ...devices['iPhone SE'],
        defaultBrowserType: 'chromium',
        viewport: { width: 375, height: 667 },
      },
    },
    // Landing (#826): Desktop Chrome, iPad Mini and iPhone 14 profiles, all
    // rendered by Chromium so baselines come from one engine on CI.
    {
      name: 'landing-desktop-chrome',
      testMatch: LANDING_SPEC,
      use: { ...devices['Desktop Chrome'] },
      expect: { toHaveScreenshot: { maxDiffPixelRatio: landingMaxDiffPixelRatio } },
    },
    {
      name: 'landing-ipad-mini',
      testMatch: LANDING_SPEC,
      use: { ...devices['iPad Mini'], defaultBrowserType: 'chromium' },
      expect: { toHaveScreenshot: { maxDiffPixelRatio: landingMaxDiffPixelRatio } },
    },
    {
      name: 'landing-iphone-14',
      testMatch: LANDING_SPEC,
      use: { ...devices['iPhone 14'], defaultBrowserType: 'chromium' },
      expect: { toHaveScreenshot: { maxDiffPixelRatio: landingMaxDiffPixelRatio } },
    },
  ],
  webServer: [
    {
      // Call the workspace script directly: `npm run dev:landing -- --port` is
      // swallowed by the nested npm call and Vite then serves a "5173" root
      // (every page 404s and screenshots come out blank).
      command: 'npm run dev --workspace=apps/landing -- --port 5173 --strictPort',
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 60 * 1000,
    },
    {
      command: 'npm run dev --workspace=apps/admin -- --port 5174 --strictPort',
      port: 5174,
      reuseExistingServer: !process.env.CI,
      timeout: 60 * 1000,
    },
  ],
});
