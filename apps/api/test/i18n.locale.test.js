const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const { t, catalog, SUPPORTED_LOCALES } = require('../src/i18n/messages');
const { formatDateByLocale, formatAmountByLocale } = require('../src/i18n/formatters');

test('t returns correct translations and replaces template params', () => {
  assert.equal(t('opt_out_success', {}, 'en').includes('unsubscribed'), true);
  assert.equal(t('opt_out_success', {}, 'fr').includes('désabonné'), true);
  assert.equal(t('opt_out_success', {}, 'es').includes('dado de baja'), true);

  assert.equal(
    t('lang_updated', { language: 'fr' }, 'fr'),
    'Langue mise à jour en fr.'
  );

  // Fallback test
  assert.equal(t('non_existent_key', {}, 'fr'), 'non_existent_key');
});

test('formatAmountByLocale formats currency and crypto without altering monetary precision', () => {
  assert.equal(formatAmountByLocale('1000.50', 'USD', 'en'), '$1,000.50');
  assert.equal(formatAmountByLocale('1000.50', 'USD', 'fr'), '1\u202f000,50\xa0$US'); // French USD formatting
  assert.equal(formatAmountByLocale('1000.50', 'USDC', 'en'), '1,000.50 USDC');
  assert.equal(formatAmountByLocale('500', 'XLM', 'es'), '500 XLM');
});

test('formatDateByLocale produces localized date string', () => {
  const date = new Date('2026-08-26T12:00:00Z');
  const enFormatted = formatDateByLocale(date, 'en');
  const frFormatted = formatDateByLocale(date, 'fr');
  assert.equal(typeof enFormatted, 'string');
  assert.equal(typeof frFormatted, 'string');
});
