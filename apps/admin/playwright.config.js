import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the admin app's functional end-to-end tests.
 * The pixel-diff suite (e2e/visual-regression.spec.js) runs from the
 * repository root config instead.
 */
export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/visual-regression.spec.js'],
  timeout: 30 * 1000,
  expect: { timeout: 5000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5174 --strictPort',
    port: 5174,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
