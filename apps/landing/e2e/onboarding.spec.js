import { test, expect } from '@playwright/test';

test.describe('OnboardingWizard E2E Journey & Form Validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.removeItem('sendam_onboarding_draft_v1');
    });
    await page.goto('/');
    const wizard = page.locator('#demo-wizard');
    await wizard.scrollIntoViewIfNeeded();
    await expect(wizard).toBeVisible();
  });

  test('formats phone numbers and switches country presets on Step 1', async ({ page }) => {
    const wizard = page.locator('#demo-wizard');
    const phoneInput = wizard.locator('#wizard-phone');
    const countryButton = wizard.locator('#wizard-country-picker');

    // Default Nigeria E.164 format
    await expect(phoneInput).toHaveValue('+234 801 234 5678');
    await expect(wizard.locator('#wizard-phone-hint')).toContainText(/Valid E\.164 format/i);

    // Switch country to Ghana
    await countryButton.click();
    const listbox = wizard.getByRole('listbox', { name: /Select country/i });
    await expect(listbox).toBeVisible();
    await listbox.getByRole('option', { name: /Ghana/i }).click();
    await expect(countryButton).toHaveAttribute('aria-label', /Selected country: Ghana/i);

    // Enter raw Ghana digits and verify E.164 auto-formatting
    await phoneInput.fill('241987654');
    await expect(phoneInput).toHaveValue('+233 24 198 7654');
    await expect(wizard.locator('#wizard-phone-hint')).toContainText(/Valid E\.164 format/i);
  });

  test('gates Step 1 when phone number is invalid and clears error on correction', async ({ page }) => {
    const wizard = page.locator('#demo-wizard');
    const phoneInput = wizard.locator('#wizard-phone');
    const nextButton = wizard.getByRole('button', { name: /Next Step/i });

    // Enter incomplete phone number
    await phoneInput.fill('8012');
    await expect(phoneInput).toHaveAttribute('aria-invalid', 'true');

    // Attempt to advance -> blocked on Step 1 with error alert
    await nextButton.click();
    const errorAlert = wizard.getByTestId('wizard-step-error');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText(/valid Nigeria phone number/i);
    await expect(wizard.getByRole('heading', { name: /Enter your WhatsApp phone number/i })).toBeVisible();

    // Fix phone number -> error clears and Step 2 opens
    await phoneInput.fill('8012345678');
    await expect(errorAlert).not.toBeVisible();
    await nextButton.click();
    await expect(wizard.getByRole('heading', { name: /Set your 4-digit security PIN/i })).toBeVisible();
  });

  test('supports uploading and removing an identity document on Step 1', async ({ page }) => {
    const wizard = page.locator('#demo-wizard');
    const fileInput = wizard.getByLabel(/Browse identity document files/i);

    await fileInput.setInputFiles({
      name: 'national-id.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 mock id document'),
    });

    await expect(wizard.getByText('national-id.pdf')).toBeVisible();
    await expect(wizard.getByText(/Identity Document \(1\/3\)/i)).toBeVisible();

    await wizard.getByRole('button', { name: /Remove national-id\.pdf/i }).click();
    await expect(wizard.getByText('national-id.pdf')).not.toBeVisible();
    await expect(wizard.getByText(/Identity Document \(0\/3\)/i)).toBeVisible();
  });

  test('gates Step 2 when security PIN is incomplete and supports Back navigation', async ({ page }) => {
    const wizard = page.locator('#demo-wizard');
    const nextButton = wizard.getByRole('button', { name: /Next Step/i });

    // Advance Step 1 -> Step 2 with valid default phone
    await nextButton.click();
    await expect(wizard.getByRole('heading', { name: /Set your 4-digit security PIN/i })).toBeVisible();

    // Attempt to proceed with empty PIN -> blocked
    await nextButton.click();
    const errorAlert = wizard.getByTestId('wizard-step-error');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText(/enter all 4 digits/i);

    // Partial PIN (only 2 digits) -> still blocked
    await wizard.locator('#wizard-pin-0').fill('1');
    await wizard.locator('#wizard-pin-1').fill('2');
    await nextButton.click();
    await expect(errorAlert).toBeVisible();
    await expect(wizard.getByRole('heading', { name: /Set your 4-digit security PIN/i })).toBeVisible();

    // Back button returns to Step 1 and clears error
    await wizard.getByRole('button', { name: /^Back$/i }).click();
    await expect(wizard.getByRole('heading', { name: /Enter your WhatsApp phone number/i })).toBeVisible();
    await expect(errorAlert).not.toBeVisible();
  });

  test('gates Step 3 on invalid transfer amount or recipient and completes valid submission', async ({ page }) => {
    const wizard = page.locator('#demo-wizard');
    const nextButton = wizard.getByRole('button', { name: /Next Step/i });

    // Step 1 -> Step 2
    await wizard.locator('#wizard-phone').fill('8098765432');
    await nextButton.click();

    // Step 2 -> Step 3
    await wizard.locator('#wizard-pin-0').fill('4');
    await wizard.locator('#wizard-pin-1').fill('2');
    await wizard.locator('#wizard-pin-2').fill('8');
    await wizard.locator('#wizard-pin-3').fill('9');
    await nextButton.click();
    await expect(wizard.getByRole('heading', { name: /Simulate your first transfer/i })).toBeVisible();

    const amountInput = wizard.locator('#wizard-amount');
    const recipientInput = wizard.locator('#wizard-recipient');
    const executeButton = wizard.getByRole('button', { name: /Execute Simulation/i });
    const errorAlert = wizard.getByTestId('wizard-step-error');

    // Invalid amount (0) -> blocked
    await amountInput.fill('0');
    await executeButton.click();
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText(/valid transfer amount/i);

    // Invalid recipient -> blocked
    await amountInput.fill('50.00');
    await recipientInput.fill('123');
    await executeButton.click();
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toContainText(/valid recipient phone/i);

    // Valid inputs -> executes simulation and reaches completion state
    await recipientInput.fill('+233 241 987 654');
    await executeButton.click();

    await expect(
      wizard.getByRole('heading', { name: /Simulated Onboarding & Transfer Complete!/i })
    ).toBeVisible({ timeout: 5000 });
    await expect(wizard.getByRole('link', { name: /Start Real Wallet on WhatsApp/i })).toBeVisible();

    // Reset simulation returns cleanly to Step 1
    await wizard.getByRole('button', { name: /Reset Simulation/i }).click();
    await expect(wizard.getByRole('heading', { name: /Enter your WhatsApp phone number/i })).toBeVisible();
  });
});
