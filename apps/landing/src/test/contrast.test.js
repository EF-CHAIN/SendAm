import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  contrastRatio,
  findLowContrastElements,
  parseRgb,
  relativeLuminance,
  startDevContrastCheck,
} from '@shared/contrast.js';
import * as a11yAudit from '@shared/a11yAudit.js';

describe('WCAG contrast maths', () => {
  it('gives 21:1 for black on white and 1:1 for identical colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('computes relative luminance for shorthand and full hex', () => {
    expect(relativeLuminance('#fff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000')).toBe(0);
  });

  it('is shared with the audit harness rather than duplicated', () => {
    expect(a11yAudit.contrastRatio).toBe(contrastRatio);
    expect(a11yAudit.relativeLuminance).toBe(relativeLuminance);
  });
});

describe('parseRgb', () => {
  it('reads rgb() and rgba() computed colours', () => {
    expect(parseRgb('rgb(15, 23, 42)')).toEqual({ r: 15, g: 23, b: 42, a: 1 });
    expect(parseRgb('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('returns null for colour formats it does not sample', () => {
    expect(parseRgb('transparent')).toBeNull();
    expect(parseRgb('oklch(0.7 0.1 200)')).toBeNull();
  });
});

describe('findLowContrastElements', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('flags text whose contrast falls below AA and names the node', () => {
    document.body.innerHTML = `
      <div style="background-color: rgb(255, 255, 255)">
        <p id="faint" style="color: rgb(200, 200, 200)">Hard to read</p>
        <p style="color: rgb(15, 23, 42)">Easy to read</p>
      </div>`;

    const failures = findLowContrastElements(document.body);

    expect(failures).toHaveLength(1);
    expect(failures[0].description).toBe('p#faint');
    expect(failures[0].ratio).toBeLessThan(4.5);
    expect(failures[0].required).toBe(4.5);
    expect(failures[0].foreground).toBe('#c8c8c8');
    expect(failures[0].background).toBe('#ffffff');
  });

  it('inherits the background from the nearest opaque ancestor', () => {
    document.body.innerHTML = `
      <section style="background-color: rgb(15, 23, 42)">
        <span style="color: rgb(30, 41, 59)">Dark on dark</span>
      </section>`;

    const failures = findLowContrastElements(document.body);

    expect(failures.map((f) => f.description)).toEqual(['span']);
  });

  it('does not report wrappers whose text belongs to children', () => {
    document.body.innerHTML = `
      <div style="background-color: rgb(255, 255, 255)">
        <p style="color: rgb(15, 23, 42)">Readable</p>
      </div>`;

    expect(findLowContrastElements(document.body)).toEqual([]);
  });

  it('skips hidden elements', () => {
    document.body.innerHTML = `
      <p style="background-color: rgb(255, 255, 255); color: rgb(200, 200, 200); display: none">Hidden</p>`;

    expect(findLowContrastElements(document.body)).toEqual([]);
  });
});

describe('startDevContrastCheck', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('does nothing outside dev mode', () => {
    vi.useFakeTimers();
    const logger = { groupCollapsed: vi.fn(), warn: vi.fn(), groupEnd: vi.fn() };
    document.body.innerHTML = `<p style="background-color: rgb(255,255,255); color: rgb(200,200,200)">x</p>`;

    expect(startDevContrastCheck({ devMode: false, logger, delay: 0 })).toBeNull();
    vi.runAllTimers();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs one grouped warning per failing element in dev mode', () => {
    vi.useFakeTimers();
    const logger = { groupCollapsed: vi.fn(), warn: vi.fn(), groupEnd: vi.fn() };
    document.body.innerHTML = `<p id="low" style="background-color: rgb(255,255,255); color: rgb(200,200,200)">x</p>`;

    startDevContrastCheck({ devMode: true, logger, delay: 10 });
    vi.advanceTimersByTime(10);

    expect(logger.groupCollapsed).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/^p#low contrast \d+(\.\d+)?:1 \(needs 4\.5:1\)/);
    expect(logger.groupEnd).toHaveBeenCalledTimes(1);
  });
});
