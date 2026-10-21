import { test, expect } from '@playwright/test';

test.describe('Admin App - Visual Regression Suite', () => {
  // Root config starts both dev servers; point relative goto() at this app's.
  test.use({ baseURL: 'http://localhost:5174' });

  test.beforeEach(async ({ page }) => {
    // Disable CSS animations & transitions for deterministic visual diffs
    await page.addInitScript(() => {
      window.__VISUAL_TESTING__ = true;
    });
  });

  const disableAnimations = async (page) => {
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
  };

  test('Admin Login view visual baseline', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await disableAnimations(page);

    await expect(page).toHaveScreenshot('admin-login.png', {
      maxDiffPixelRatio: 0.002, // max 0.2% diff tolerance
      fullPage: true,
    });
  });

  test('Admin Dashboard overview and canvas chart visual baseline', async ({ page }) => {
    // Mock authentication and stats endpoint
    await page.route('**/api/admin/stats', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalUsers: 1420,
          totalWallets: 1380,
          totalTransactions: 9850,
          successfulTransactions: 9600,
          failedTransactions: 120,
          pendingTransactions: 130,
          pendingKyc: 42,
          balances: [
            { asset: 'USDC', amount: '254000', baseAmount: 254000, baseCurrency: 'USD', source: 'Stellar DEX' },
            { asset: 'XLM', amount: '1200000', baseAmount: 132000, baseCurrency: 'USD', source: 'CoinGecko' },
          ],
        }),
      });
    });

    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    await disableAnimations(page);

    await expect(page).toHaveScreenshot('admin-dashboard.png', {
      maxDiffPixelRatio: 0.002,
      fullPage: true,
    });
  });

  test('Admin Transactions table and filter bar visual baseline', async ({ page }) => {
    await page.route('**/api/admin/transactions*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'tx_demo_001',
              type: 'payment',
              status: 'success',
              amount: '50.00',
              asset: 'USDC',
              fiatAmount: '75000',
              fiatCurrency: 'NGN',
              rail: 'stellar',
              destination: 'GA53W2PEEL2PKVN2IJGDPA2QRYWHC7LMFP4IAGAVMQZZAVX2VNRNGX6M',
              createdAt: '2026-03-20T12:00:00.000Z',
            },
            {
              id: 'tx_demo_002',
              type: 'payout',
              status: 'pending',
              amount: '120.00',
              asset: 'USDC',
              fiatAmount: '16000',
              fiatCurrency: 'KES',
              rail: 'stellar',
              destination: 'GBZXN7PIRZGNMHGA728RGRYAHA2FB2W2YDO5GLWJ46CXUSG6UUR2BQRP',
              createdAt: '2026-03-20T12:30:00.000Z',
            },
          ],
          total: 2,
          page: 1,
        }),
      });
    });

    await page.goto('/transactions');
    await page.waitForLoadState('networkidle');
    await disableAnimations(page);

    await expect(page).toHaveScreenshot('admin-transactions.png', {
      maxDiffPixelRatio: 0.002,
      fullPage: true,
    });
  });

  test('Admin KYC review queue visual baseline', async ({ page }) => {
    await page.route('**/api/admin/kyc*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'kyc_demo_001',
              phoneNumber: '+2348012345678',
              status: 'PENDING',
              level: 'TIER_1',
              submittedAt: '2026-03-20T10:00:00.000Z',
            },
          ],
          total: 1,
        }),
      });
    });

    await page.goto('/kyc');
    await page.waitForLoadState('networkidle');
    await disableAnimations(page);

    await expect(page).toHaveScreenshot('admin-kyc.png', {
      maxDiffPixelRatio: 0.002,
      fullPage: true,
    });
  });
});
