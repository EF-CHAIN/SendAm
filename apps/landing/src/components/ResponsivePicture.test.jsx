import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import ResponsivePicture from './ResponsivePicture.jsx';
import { buildSrcSet } from '@/lib/srcset.js';
import { HERO_WALLPAPER } from '@/lib/heroImages.js';

const publicDir = resolve(__dirname, '../../public');

describe('buildSrcSet', () => {
  it('builds width descriptors per format', () => {
    expect(buildSrcSet('/img/a', [600, 1200], 'avif')).toBe(
      '/img/a-600.avif 600w, /img/a-1200.avif 1200w',
    );
  });

  it('drops invalid widths and returns empty for bad input (failure modes)', () => {
    expect(buildSrcSet('/img/a', [0, -5, 1.5, 'x', 600], 'webp')).toBe('/img/a-600.webp 600w');
    expect(buildSrcSet('/img/a', [], 'webp')).toBe('');
    expect(buildSrcSet('/img/a', undefined, 'webp')).toBe('');
    expect(buildSrcSet('', [600], 'webp')).toBe('');
  });
});

describe('ResponsivePicture', () => {
  it('renders AVIF then WebP sources in order, then the fallback img', () => {
    const { container } = render(<ResponsivePicture {...HERO_WALLPAPER} />);
    const sources = container.querySelectorAll('picture > source');
    expect([...sources].map((s) => s.getAttribute('type'))).toEqual(['image/avif', 'image/webp']);
    expect(sources[0].getAttribute('srcset')).toContain('hero-wallpaper-600.avif 600w');
    expect(sources[0].getAttribute('srcset')).toContain('hero-wallpaper-1200.avif 1200w');
    expect(sources[0].getAttribute('sizes')).toBe(HERO_WALLPAPER.sizes);
    expect(container.querySelector('picture > img')).toHaveAttribute('src', '/whatsapp-bg.png');
  });

  it('is decorative by default and reserves its box to avoid layout shift', () => {
    const { container } = render(<ResponsivePicture {...HERO_WALLPAPER} />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('width', '600');
    expect(img).toHaveAttribute('height', '600');
  });

  it('loads eagerly with high priority only when marked as priority', () => {
    const lazy = render(<ResponsivePicture {...HERO_WALLPAPER} />).container.querySelector('img');
    expect(lazy).toHaveAttribute('loading', 'lazy');
    const eager = render(<ResponsivePicture {...HERO_WALLPAPER} priority />).container.querySelector('img');
    expect(eager).toHaveAttribute('loading', 'eager');
    expect(eager).toHaveAttribute('fetchpriority', 'high');
  });

  it('degrades to the fallback img when widths are invalid or formats unknown', () => {
    const { container } = render(
      <ResponsivePicture basePath="/img/a" widths={[]} formats={['avif', 'tiff']} fallbackSrc="/fallback.png" />,
    );
    expect(container.querySelectorAll('source')).toHaveLength(0);
    expect(container.querySelector('img')).toHaveAttribute('src', '/fallback.png');
  });
});

describe('hero image assets', () => {
  const files = HERO_WALLPAPER.formats.flatMap((format) =>
    HERO_WALLPAPER.widths.map((w) => `${HERO_WALLPAPER.basePath}-${w}.${format}`),
  );

  it('ships every variant declared in the manifest, plus the fallback', () => {
    files.concat(HERO_WALLPAPER.fallbackSrc).forEach((file) => {
      expect(existsSync(resolve(publicDir, `.${file}`)), `${file} should exist`).toBe(true);
    });
  });

  it('keeps mobile 1x and 2x transfers under 100KB for every format', () => {
    const [w1x, w2x] = HERO_WALLPAPER.widths;
    HERO_WALLPAPER.formats.forEach((format) => {
      [w1x, w2x].forEach((w) => {
        const size = statSync(resolve(publicDir, `.${HERO_WALLPAPER.basePath}-${w}.${format}`)).size;
        expect(size, `${format} ${w}w`).toBeLessThan(100 * 1024);
      });
    });
  });
});
