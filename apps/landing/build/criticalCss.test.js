import { describe, expect, it, vi } from 'vitest';
import criticalCss, { collectCssAssets, inlineCriticalCss, replaceRootContent } from './criticalCss.js';
import { stripHoistedResources } from './renderShell.js';

const CSS = [
  '.above{color:red}',
  '.below-the-fold{color:blue}',
  '.nav .link{margin:0}',
].join('\n');

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>t</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

const assets = { 'assets/index-abc.css': CSS };
const silent = { warn: vi.fn() };

describe('collectCssAssets', () => {
  it('returns only emitted CSS assets, decoding binary sources', () => {
    const bundle = {
      a: { type: 'asset', fileName: 'assets/a.css', source: '.a{}' },
      b: { type: 'asset', fileName: 'assets/b.css', source: new TextEncoder().encode('.b{}') },
      c: { type: 'chunk', fileName: 'assets/c.js', code: '' },
      d: { type: 'asset', fileName: 'icon.svg', source: '<svg/>' },
    };
    expect(collectCssAssets(bundle)).toEqual({ 'assets/a.css': '.a{}', 'assets/b.css': '.b{}' });
    expect(collectCssAssets(undefined)).toEqual({});
  });
});

describe('inlineCriticalCss', () => {
  it('inlines only the rules used above the fold and defers the full stylesheet', async () => {
    const out = await inlineCriticalCss({
      html: HTML,
      cssAssets: assets,
      analysisMarkup: '<nav class="nav"><a class="link above">x</a></nav>',
      shellMarkup: '<nav class="nav"></nav>',
      logger: silent,
    });
    const style = out.match(/<style>([\s\S]*?)<\/style>/)[1];
    expect(style).toContain('.above');
    expect(style).toContain('.nav .link');
    expect(style).not.toContain('.below-the-fold');
    // The full stylesheet still loads, but no longer blocks rendering.
    expect(out).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/index-abc\.css" media="print" onload="this\.media='all'">/);
    expect(out).toMatch(/<noscript><link rel="stylesheet" crossorigin href="\/assets\/index-abc\.css"><\/noscript>/);
    // Only the shell ships inside #root; the analysis-only markup is dropped.
    expect(out).toContain('<div id="root"><nav class="nav"></nav></div>');
    expect(out).not.toContain('class="link above"');
    expect(out).toContain('<script type="module" crossorigin src="/assets/index-abc.js"></script>');
  });

  it('keeps #root empty when no shell is supplied', async () => {
    const out = await inlineCriticalCss({
      html: HTML,
      cssAssets: assets,
      analysisMarkup: '<p class="above">x</p>',
      logger: silent,
    });
    expect(out).toContain('<div id="root"></div>');
  });

  it('returns the HTML unchanged when the build emitted no CSS', async () => {
    expect(await inlineCriticalCss({ html: HTML, cssAssets: {}, logger: silent })).toBe(HTML);
  });

  it('returns the HTML unchanged when there is no empty #root mount point', async () => {
    const html = HTML.replace('<div id="root"></div>', '<main></main>');
    expect(await inlineCriticalCss({ html, cssAssets: assets, logger: silent })).toBe(html);
  });

  it('falls back to the original HTML and warns when a stylesheet cannot be read', async () => {
    const logger = { warn: vi.fn() };
    const out = await inlineCriticalCss({
      html: HTML,
      cssAssets: { 'assets/other.css': CSS },
      analysisMarkup: '<p class="above">x</p>',
      logger,
    });
    expect(out).toBe(HTML);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/\[critical-css\] skipped/));
  });
});

describe('replaceRootContent', () => {
  it('replaces nested markup inside #root and keeps what follows', () => {
    const html = '<body><div id="root"><div><div>a</div></div><span>b</span></div><script></script></body>';
    expect(replaceRootContent(html, 'X')).toBe('<body><div id="root">X</div><script></script></body>');
  });

  it('throws on a missing or unbalanced #root', () => {
    expect(() => replaceRootContent('<body></body>', '')).toThrow(/#root not found/);
    expect(() => replaceRootContent('<div id="root"><div>', '')).toThrow(/unbalanced/);
  });
});

describe('stripHoistedResources', () => {
  it('removes React resource hints from rendered markup', () => {
    expect(stripHoistedResources('<link rel="preload" as="image" href="/a.svg"/><nav></nav>')).toBe('<nav></nav>');
  });
});

describe('criticalCss plugin', () => {
  const ctx = { bundle: { css: { type: 'asset', fileName: 'assets/index-abc.css', source: CSS } } };

  it('only runs during builds', () => {
    expect(criticalCss().apply).toBe('build');
  });

  it('transforms index.html from the in-memory bundle', async () => {
    const plugin = criticalCss({
      renderMarkup: async () => ({ analysis: '<p class="above"></p>', shell: '' }),
    });
    plugin.configResolved({ base: '/', logger: silent });
    const out = await plugin.transformIndexHtml.handler(HTML, ctx);
    expect(plugin.transformIndexHtml.order).toBe('post');
    expect(out).toMatch(/<style>[^<]*\.above/);
  });

  it('keeps the stylesheet render-blocking when the above-the-fold render fails and nothing matches', async () => {
    const logger = { warn: vi.fn() };
    const plugin = criticalCss({
      renderMarkup: async () => {
        throw new Error('boom');
      },
    });
    plugin.configResolved({ base: '/', logger });
    const out = await plugin.transformIndexHtml.handler(HTML, ctx);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/render failed: boom/));
    // Deferring without any inlined rules would flash unstyled content.
    expect(out).toBe(HTML);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no critical rules were inlined/));
  });
});
