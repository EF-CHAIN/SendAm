import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom has no layout/animation engine, so a `prefers-reduced-motion` media
// query can't be exercised by rendering — assert the stylesheet itself
// honors it instead of testing computed styles that jsdom can't produce.
// Vitest runs with cwd set to this workspace root, so resolve relative to that
// rather than `import.meta.url` (which Vitest's module runner doesn't always
// give a real file:// URL).
const css = readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');

describe('global stylesheet', () => {
  it('disables animations and smooth scrolling for prefers-reduced-motion', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    const reducedMotionBlock = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reducedMotionBlock).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(reducedMotionBlock).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
  });
});
