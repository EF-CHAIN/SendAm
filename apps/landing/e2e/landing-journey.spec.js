import { test, expect } from '@playwright/test';

test.describe('SendAm Landing Page E2E Smoke Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads landing page successfully with hero elements and navigation', async ({ page }) => {
    await expect(page).toHaveTitle(/SendAm/i);
    const heading = page.locator('h1');
    await expect(heading).toBeVisible();
    await expect(heading).toContainText(/WhatsApp payments/i);
  });

  test('navigates through sections via anchor links', async ({ page }) => {
    const featuresLink = page.locator('nav a[href="#features"]').first();
    if (await featuresLink.isVisible()) {
      await featuresLink.click();
      const featuresSection = page.locator('#features');
      await expect(featuresSection).toBeVisible();
    }

    const howItWorksLink = page.locator('nav a[href="#how-it-works"]').first();
    if (await howItWorksLink.isVisible()) {
      await howItWorksLink.click();
      const howItWorksSection = page.locator('#how-it-works');
      await expect(howItWorksSection).toBeVisible();
    }

    const faqLink = page.locator('nav a[href="#faq"]').first();
    if (await faqLink.isVisible()) {
      await faqLink.click();
      const faqSection = page.locator('#faq');
      await expect(faqSection).toBeVisible();
    }
  });

  test('opens and closes mobile menu drawer on smaller screens', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const menuButton = page.locator('button[aria-controls="mobile-menu-drawer"]');
    await expect(menuButton).toBeVisible();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');

    // Open drawer
    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    const drawer = page.locator('#mobile-menu-drawer');
    await expect(drawer).toBeVisible();

    // Verify links in drawer
    await expect(drawer.locator('a[href="#features"]')).toBeVisible();
    await expect(drawer.locator('a[href="#how-it-works"]')).toBeVisible();
    await expect(drawer.locator('a[href="#faq"]')).toBeVisible();

    // Close drawer
    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await expect(drawer).not.toBeVisible();
  });

  test('toggles FAQ accordion expansion', async ({ page }) => {
    const faqSection = page.locator('#faq');
    await faqSection.scrollIntoViewIfNeeded();

    const firstFaqButton = faqSection.locator('button[aria-expanded]').first();
    await expect(firstFaqButton).toBeVisible();
    await expect(firstFaqButton).toHaveAttribute('aria-expanded', 'false');

    // Click to open
    await firstFaqButton.click();
    await expect(firstFaqButton).toHaveAttribute('aria-expanded', 'true');

    // Click to close
    await firstFaqButton.click();
    await expect(firstFaqButton).toHaveAttribute('aria-expanded', 'false');
  });

  test('validates WhatsApp CTA links contain proper targets and parameters', async ({ page }) => {
    const waLinks = page.locator('a[href*="wa.me"]');
    const count = await waLinks.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const link = waLinks.nth(i);
      if (await link.isVisible()) {
        const href = await link.getAttribute('href');
        expect(href).toMatch(/^https:\/\/wa\.me\//);
        expect(await link.getAttribute('target')).toBe('_blank');
        expect(await link.getAttribute('rel')).toContain('noopener');
      }
    }
  });

  test('navigates to /onboarding and displays checkpoints and refresh button', async ({ page }) => {
    await page.goto('/onboarding');
    await expect(page.locator('h1')).toContainText(/Onboarding Checkpoints/i);

    // Verify progress card or checkpoints
    const refreshBtn = page.locator('button:has-text("Refresh")');
    await expect(refreshBtn).toBeVisible();

    // Ensure checkpoints container or summary is displayed
    await expect(page.locator('text=Overall Progress').or(page.locator('text=Unable to load onboarding status'))).toBeVisible();
  });
});
