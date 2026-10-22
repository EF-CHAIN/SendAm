import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = path.join(appRoot, 'public');
const manifest = JSON.parse(readFileSync(path.join(publicDir, 'manifest.json'), 'utf8'));
const BRAND_THEME = '#0f172a';

// Reads width/height from a PNG IHDR chunk.
const pngSize = (file) => {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const iconFor = (size) => manifest.icons.find((icon) => icon.sizes === `${size}x${size}`);

describe('web app manifest', () => {
  it('declares the installable app basics', () => {
    expect(manifest.name).toBe('SendAm');
    expect(manifest.short_name).toBe('SendAm');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('uses the brand navy for the theme and splash colours', () => {
    expect(manifest.theme_color).toBe(BRAND_THEME);
    expect(manifest.background_color).toBe(BRAND_THEME);
  });

  it.each([192, 512])('ships a %ipx icon usable as both any and maskable', (size) => {
    const icon = iconFor(size);
    expect(icon).toBeDefined();
    expect(icon.type).toBe('image/png');
    expect(icon.purpose.split(/\s+/).sort()).toEqual(['any', 'maskable']);
    const file = path.join(publicDir, icon.src);
    expect(existsSync(file)).toBe(true);
    expect(pngSize(file)).toEqual({ width: size, height: size });
  });

  it('points every icon, shortcut icon and screenshot at an existing file of the stated size', () => {
    const entries = [
      ...manifest.icons,
      ...manifest.screenshots,
      ...manifest.shortcuts.flatMap((shortcut) => shortcut.icons),
    ];
    for (const entry of entries) {
      const file = path.join(publicDir, entry.src);
      expect(existsSync(file), entry.src).toBe(true);
      const [width, height] = entry.sizes.split('x').map(Number);
      expect(pngSize(file), entry.src).toEqual({ width, height });
    }
  });

  it('keeps icon sizes unique and purposes valid', () => {
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(new Set(sizes).size).toBe(sizes.length);
    for (const icon of manifest.icons) {
      for (const purpose of icon.purpose.split(/\s+/)) {
        expect(['any', 'maskable', 'monochrome']).toContain(purpose);
      }
    }
  });

  it('matches the theme-color meta tag and is the manifest vite-plugin-pwa emits', () => {
    const html = readFileSync(path.join(appRoot, 'index.html'), 'utf8');
    expect(html).toContain(`<meta name="theme-color" content="${BRAND_THEME}" />`);
    expect(html).toContain('<link rel="manifest" href="/manifest.json" />');
    const viteConfig = readFileSync(path.join(appRoot, 'vite.config.js'), 'utf8');
    expect(viteConfig).toMatch(/manifest:\s*JSON\.parse\(readFileSync\([^)]*public\/manifest\.json/);
  });
});
