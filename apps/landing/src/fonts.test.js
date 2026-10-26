import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../tailwind.config.js';

const root = process.cwd();
const indexHtml = readFileSync(path.join(root, 'index.html'), 'utf8');
const faces = [...indexHtml.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
const webFaces = faces.filter((face) => /src:\s*url\(/.test(face));
const fallbackFaces = faces.filter((face) => /src:\s*local\(/.test(face));

describe('self-hosted landing fonts', () => {
  it('makes no requests to Google Fonts', () => {
    expect(indexHtml).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    const csp = readFileSync(path.join(root, 'vercel.json'), 'utf8');
    expect(csp).toMatch(/font-src 'self';/);
    expect(csp).not.toMatch(/fonts\.(googleapis|gstatic)/);
  });

  it('preloads every self-hosted WOFF2 file, and each file is real WOFF2', () => {
    const preloads = [...indexHtml.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin \/>/g)].map(
      (m) => m[1],
    );
    expect(preloads).toEqual(['/fonts/inter-latin-wght-normal.woff2', '/fonts/outfit-latin-wght-normal.woff2']);
    for (const href of preloads) {
      const file = path.join(root, 'public', href);
      expect(existsSync(file), href).toBe(true);
      expect(readFileSync(file).subarray(0, 4).toString('latin1'), href).toBe('wOF2');
    }
  });

  it('declares Inter and Outfit with font-display: swap for the Latin subset', () => {
    expect(webFaces).toHaveLength(2);
    for (const family of ['Inter', 'Outfit']) {
      const face = webFaces.find((f) => f.includes(`font-family: '${family}'`));
      expect(face, family).toBeDefined();
      expect(face).toMatch(/font-display: swap;/);
      expect(face).toMatch(/unicode-range: U\+0000-00FF/);
      expect(face).toMatch(/font-weight: 100 900;/);
    }
  });

  it('defines metric-matched fallbacks so the swap does not shift layout', () => {
    expect(fallbackFaces).toHaveLength(2);
    for (const face of fallbackFaces) {
      expect(face).toMatch(/size-adjust: [\d.]+%;/);
      expect(face).toMatch(/ascent-override: [\d.]+%;/);
      expect(face).toMatch(/descent-override: [\d.]+%;/);
    }
    const { fontFamily } = tailwindConfig.theme.extend;
    expect(fontFamily.sans.slice(0, 2)).toEqual(['Inter', 'Inter Fallback']);
    expect(fontFamily.display.slice(0, 2)).toEqual(['Outfit', 'Outfit Fallback']);
  });

  it('ships the font licences next to the files', () => {
    for (const name of ['LICENSE-Inter.txt', 'LICENSE-Outfit.txt']) {
      expect(readFileSync(path.join(root, 'public/fonts', name), 'utf8')).toMatch(/SIL Open Font License/);
    }
  });
});
