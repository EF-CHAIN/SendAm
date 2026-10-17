import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the Chat Simulator (Expo web build).
 * The API is mocked inside the specs, so no backend or database is required.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30 * 1000,
  expect: { timeout: 7000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8081',
    trace: 'on-first-retry',
    viewport: { width: 420, height: 800 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 420, height: 800 } } }],
  webServer: {
    command: 'npx expo start --web --port 8081',
    port: 8081,
    reuseExistingServer: !process.env.CI,
    timeout: 180 * 1000,
  },
});
