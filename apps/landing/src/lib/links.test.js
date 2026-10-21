import { describe, expect, it } from 'vitest';
import { ADMIN_URL, GITHUB_URL, STELLAR_URL, normalizeAdminUrl, whatsappUrl } from './links.js';

describe('whatsappUrl', () => {
  it('falls back to the open wa.me chat when no number is configured', () => {
    // apps/landing/.env.example ships VITE_WHATSAPP_NUMBER unset, and the
    // test environment doesn't set it either, so this exercises the default.
    expect(whatsappUrl('create wallet')).toBe('https://wa.me/?text=create%20wallet');
  });

  it('defaults the message to "create wallet" when called with no arguments', () => {
    expect(whatsappUrl()).toBe('https://wa.me/?text=create%20wallet');
  });

  it('URL-encodes the prefilled message', () => {
    expect(whatsappUrl('send 25000 NGN to Ada')).toBe(
      'https://wa.me/?text=send%2025000%20NGN%20to%20Ada'
    );
  });
});

describe('configured link constants', () => {
  it('exposes an admin URL with a safe local default', () => {
    expect(ADMIN_URL).toBe('http://localhost:3001');
  });

  it('exposes the project GitHub and Stellar links', () => {
    expect(GITHUB_URL).toBe('https://github.com/Gozirimdev/SendAm');
    expect(STELLAR_URL).toBe('https://stellar.org');
  });
});

describe('normalizeAdminUrl', () => {
  it('falls back when the variable is undefined, empty, or blank', () => {
    expect(normalizeAdminUrl(undefined)).toBe('http://localhost:3001');
    expect(normalizeAdminUrl('')).toBe('http://localhost:3001');
    expect(normalizeAdminUrl('   ')).toBe('http://localhost:3001');
  });

  it('trims and keeps a configured URL', () => {
    expect(normalizeAdminUrl('https://admin.sendam.io')).toBe('https://admin.sendam.io');
    expect(normalizeAdminUrl('  https://admin.sendam.io  ')).toBe('https://admin.sendam.io');
  });
});
