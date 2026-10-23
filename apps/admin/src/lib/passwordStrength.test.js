import { describe, expect, it } from 'vitest';
import { getPasswordStrength, MIN_PASSWORD_LENGTH, STRONG_PASSWORD_SCORE } from './passwordStrength';

// These are public, synthetic fixtures, never real credentials.
describe('local password strength', () => {
  it('keeps the existing length rule and uses the highest estimator score', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(STRONG_PASSWORD_SCORE).toBe(4);
    expect(getPasswordStrength('')).toMatchObject({ level: 0, isStrong: false, meetsLength: false });
    expect(getPasswordStrength('V9!qR2@xM7#')).toMatchObject({ label: 'Good', isStrong: false, meetsLength: false });
    expect(getPasswordStrength('V9!qR2@xM7#t')).toMatchObject({ label: 'Strong', isStrong: true, meetsLength: true });
  });

  it.each([
    'Password123!', 'P@ssw0rd12345!', 'passwordpassword', 'qwertyuiop123',
    'abcdefghijkl', '111111111111', 'abcabcabcabc', '123456789012', 'Sendam123456!',
  ])('rejects predictable fixture %# despite its length', (password) => {
    expect(getPasswordStrength(password)).toMatchObject({ isStrong: false, meetsLength: true });
  });

  it.each([
    ['Password123!', 'Weak', 1],
    ['sunshine2026!', 'Fair', 2],
    ['horizon2026!?', 'Good', 3],
    ['orchid nebula lantern glacier', 'Strong', 4],
  ])('maps estimator fixture %# to one of four meter levels', (password, label, level) => {
    expect(getPasswordStrength(password)).toMatchObject({ label, level, isStrong: level === 4 });
  });

  it.each(['orchid nebula lantern glacier', 'V9!qR2@xM7#tL5$w'])('accepts strong fixture %# without mandatory composition rules', (password) => {
    expect(getPasswordStrength(password).isStrong).toBe(true);
  });

  it('bounds long-input estimation without adding strength for an unchecked suffix', () => {
    const weakPrefix = 'a'.repeat(100);
    expect(getPasswordStrength(weakPrefix + 'V9!qR2@xM7#tL5$w').isStrong).toBe(false);
    expect(getPasswordStrength('orchid nebula lantern glacier '.repeat(100)).isStrong).toBe(true);
  });

  it('returns guidance and status, never passwords or matched tokens', () => {
    const password = 'V9!qR2@xM7#tL5$w';
    const result = getPasswordStrength(password);
    expect(Object.keys(result).sort()).toEqual(['feedback', 'isStrong', 'label', 'level', 'meetsLength']);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(getPasswordStrength('Password123!').feedback).toMatch(/common|uncommon/i);
  });
});
