import { test, expect } from '@playwright/test';

// Expected values are written out by hand from the published indicative rates
// (src/lib/currencyConstants.js) so this suite is an independent check of the
// calculator math, not a re-run of the same code:
//   payout = (amount - 1% fee) * rate, shown with two decimals in en-US format.
// The rate table offers 9 corridors (3 sources x 3 targets); the 10th preset
// re-checks USD -> NGN with a typed, non-preset amount.
const PRESET_CORRIDORS = [
  { source: 'USD', target: 'NGN', amount: '100', fee: '$1.00', traditional: '$7.00', payout: '₦ 153,450.00', rate: '1 USD = 1,550 NGN' },
  { source: 'USD', target: 'KES', amount: '50', fee: '$0.50', traditional: '$3.50', payout: 'KSh 6,385.50', rate: '1 USD = 129 KES' },
  { source: 'USD', target: 'GHS', amount: '250', fee: '$2.50', traditional: '$17.50', payout: 'GH₵ 3,836.25', rate: '1 USD = 15.5 GHS' },
  { source: 'GBP', target: 'NGN', amount: '500', fee: '£5.00', traditional: '£35.00', payout: '₦ 980,100.00', rate: '1 GBP = 1,980 NGN' },
  { source: 'GBP', target: 'KES', amount: '100', fee: '£1.00', traditional: '£7.00', payout: 'KSh 16,335.00', rate: '1 GBP = 165 KES' },
  { source: 'GBP', target: 'GHS', amount: '50', fee: '£0.50', traditional: '£3.50', payout: 'GH₵ 980.10', rate: '1 GBP = 19.8 GHS' },
  { source: 'EUR', target: 'NGN', amount: '250', fee: '€2.50', traditional: '€17.50', payout: '₦ 415,800.00', rate: '1 EUR = 1,680 NGN' },
  { source: 'EUR', target: 'KES', amount: '500', fee: '€5.00', traditional: '€35.00', payout: 'KSh 69,300.00', rate: '1 EUR = 140 KES' },
  { source: 'EUR', target: 'GHS', amount: '100', fee: '€1.00', traditional: '€7.00', payout: 'GH₵ 1,663.20', rate: '1 EUR = 16.8 GHS' },
  { source: 'USD', target: 'NGN', amount: '1234.56', fee: '$12.35', traditional: '$86.42', payout: '₦ 1,894,432.32', rate: '1 USD = 1,550 NGN' },
];

const PRESET_AMOUNTS = ['50', '100', '250', '500'];

test.use({ locale: 'en-US' });

test.describe('CurrencyCalculator corridors and math', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#calculator');
    await expect(page.getByRole('heading', { name: /see how much your recipient gets/i })).toBeVisible();
  });

  const calculator = (page) => {
    const section = page.locator('#calculator');
    return {
      section,
      amount: section.getByRole('textbox', { name: /send amount in/i }),
      source: section.getByLabel('Source Currency'),
      target: section.getByLabel(/recipient gets/i),
      payout: section.getByTestId('calculator-payout'),
      fee: section.getByTestId('calculator-fee'),
      traditional: section.getByTestId('calculator-traditional-fee'),
      savings: section.getByTestId('calculator-savings'),
      rate: section.getByTestId('calculator-rate'),
      whatsapp: section.getByTestId('calculator-whatsapp-link'),
    };
  };

  const whatsappText = async (link) => {
    const href = await link.getAttribute('href');
    return new URL(href).searchParams.get('text');
  };

  for (const corridor of PRESET_CORRIDORS) {
    test(`${corridor.source} -> ${corridor.target} for ${corridor.amount}`, async ({ page }) => {
      const c = calculator(page);
      await c.source.selectOption(corridor.source);
      await c.target.selectOption(corridor.target);
      if (PRESET_AMOUNTS.includes(corridor.amount)) {
        await c.section.getByRole('button', { name: new RegExp(`^\\D${corridor.amount}$`) }).click();
      } else {
        await c.amount.fill(corridor.amount);
      }

      await expect(c.amount).toHaveValue(corridor.amount);
      await expect(c.rate).toHaveText(corridor.rate);
      await expect(c.fee).toHaveText(corridor.fee);
      await expect(c.traditional).toHaveText(corridor.traditional);
      await expect(c.payout).toHaveText(corridor.payout);
      expect(await whatsappText(c.whatsapp)).toBe(
        `send ${corridor.amount} ${corridor.source} to ${corridor.target}`,
      );
    });
  }

  test('corridor tabs switch the target currency and keep the amount', async ({ page }) => {
    const c = calculator(page);
    await c.amount.fill('200');
    await c.section.getByRole('button', { name: /send to kenya \(KES\)/i }).click();
    await expect(c.target).toHaveValue('KES');
    await expect(c.payout).toHaveText('KSh 25,542.00');
    await c.section.getByRole('button', { name: /send to ghana \(GHS\)/i }).click();
    await expect(c.payout).toHaveText('GH₵ 3,069.00');
    expect(await whatsappText(c.whatsapp)).toBe('send 200 USD to GHS');
  });

  test('switching the source currency recomputes the fee in that currency', async ({ page }) => {
    const c = calculator(page);
    await c.source.selectOption('GBP');
    await expect(c.amount).toHaveAccessibleName('Send amount in GBP');
    await expect(c.fee).toHaveText('£1.00');
    await expect(c.payout).toHaveText('₦ 196,020.00');
    await expect(c.savings).toHaveText('£6.00 (₦11,880)');
  });

  test('rejects invalid input and keeps the last valid amount', async ({ page }) => {
    const c = calculator(page);
    await c.amount.fill('75');
    await c.amount.pressSequentially('x');
    await expect(c.amount).toHaveValue('75');
    await c.amount.fill('');
    await c.amount.pressSequentially('-5');
    await expect(c.amount).toHaveValue('5');
    await c.amount.fill('1.25');
    await c.amount.pressSequentially('9');
    await expect(c.amount).toHaveValue('1.25');
  });

  test('an empty amount shows zero payout and fees', async ({ page }) => {
    const c = calculator(page);
    await c.amount.fill('');
    await expect(c.payout).toHaveText('₦ 0.00');
    await expect(c.fee).toHaveText('$0.00');
    await expect(c.savings).toHaveText('$0.00 (₦0)');
    expect(await whatsappText(c.whatsapp)).toBe('send  USD to NGN');
  });
});
