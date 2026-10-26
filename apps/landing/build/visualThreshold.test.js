import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_DIFF_PIXEL_RATIO,
  MAX_ALLOWED_DIFF_PIXEL_RATIO,
  resolveMaxDiffPixelRatio,
} from './visualThreshold.js';

describe('resolveMaxDiffPixelRatio', () => {
  it('defaults to a tolerance below 0.1%', () => {
    expect(resolveMaxDiffPixelRatio({})).toBe(DEFAULT_MAX_DIFF_PIXEL_RATIO);
    expect(resolveMaxDiffPixelRatio({ VISUAL_MAX_DIFF_PIXEL_RATIO: '' })).toBe(DEFAULT_MAX_DIFF_PIXEL_RATIO);
    expect(DEFAULT_MAX_DIFF_PIXEL_RATIO).toBeLessThan(MAX_ALLOWED_DIFF_PIXEL_RATIO);
  });

  it('accepts a configured ratio inside the allowed range', () => {
    expect(resolveMaxDiffPixelRatio({ VISUAL_MAX_DIFF_PIXEL_RATIO: '0.0002' })).toBe(0.0002);
  });

  it.each(['0', '-0.0001', '0.001', '0.5', 'abc'])('rejects %s', (value) => {
    expect(() => resolveMaxDiffPixelRatio({ VISUAL_MAX_DIFF_PIXEL_RATIO: value })).toThrow(
      /VISUAL_MAX_DIFF_PIXEL_RATIO must be a number/,
    );
  });
});
