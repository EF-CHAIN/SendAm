import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright Configuration for Automated Visual Regression Testing Pipeline.
 * Closes #589.
 */
export default defineConfig({
  testDir: './',
  testMatch: ['**/e2e/visual-regression.spec.js'],
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
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'tablet',
      use: {
        ...devices['iPad Mini'],
        // CI installs Chromium only; keep the iPad viewport/touch profile but not WebKit.
        defaultBrowserType: 'chromium',
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone SE'],
        defaultBrowserType: 'chromium',
        viewport: { width: 375, height: 667 },
      },
    },
  ],
  webServer: [
    {
      command: 'npm run dev:landing -- --port 5173',
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 60 * 1000,
    },
    {
      command: 'npm run dev:admin -- --port 5174',
      port: 5174,
      reuseExistingServer: !process.env.CI,
      timeout: 60 * 1000,
    },
  ],
});
