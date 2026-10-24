import { describe, expect, it, vi } from 'vitest';
import offlinePage, { OFFLINE_FILENAME, rateRows, renderOfflinePage } from './offlinePage.js';
import { EXCHANGE_RATES } from '../src/lib/currencyConstants.js';

describe('rateRows', () => {
  it('lists every published corridor with its indicative rate', () => {
    const rows = rateRows();
    expect(rows).toHaveLength(9);
    expect(rows).toContainEqual({ source: 'USD', target: 'NGN', country: 'Nigeria', rate: EXCHANGE_RATES.USD.NGN });
  });

  it('skips corridors without a valid rate', () => {
    const rows = rateRows(
      { USD: { NGN: 1550, KES: 0, GHS: Number.NaN } },
      [{ code: 'USD' }, { code: 'EUR' }],
      [{ code: 'NGN', country: 'Nigeria' }, { code: 'KES', country: 'Kenya' }, { code: 'GHS', country: 'Ghana' }],
    );
    expect(rows).toEqual([{ source: 'USD', target: 'NGN', country: 'Nigeria', rate: 1550 }]);
  });
});

describe('renderOfflinePage', () => {
  const html = renderOfflinePage({ logoSvg: '<svg aria-hidden="true"></svg>' });

  it('is a branded, self-contained page with a retry button', () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<title>You're offline | SendAm</title>");
    expect(html).toContain('<span>SendAm</span>');
    expect(html).toContain('<svg aria-hidden="true"></svg>');
    expect(html).toMatch(/<button type="button" id="retry">Retry connection<\/button>/);
    expect(html).toContain("window.addEventListener('online', retry)");
    // Nothing that would need the network.
    expect(html).not.toMatch(/<link\b|<script[^>]+src=|https?:\/\/(?!www\.w3\.org)/);
  });

  it('shows the cached currency table', () => {
    expect(html).toContain('<td>USD &rarr; NGN</td><td>Nigeria</td><td class="num">1,550</td>');
    expect(html.match(/<tr><td>/g)).toHaveLength(9);
  });

  it('escapes table content and degrades without rates', () => {
    const unsafe = renderOfflinePage({
      rates: { A: { B: 2 } },
      sources: [{ code: 'A' }],
      targets: [{ code: 'B', country: '<script>x</script>' }],
    });
    expect(unsafe).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(renderOfflinePage({ rates: {}, sources: [], targets: [] })).toContain('Rates are unavailable offline.');
  });
});

describe('offlinePage plugin', () => {
  it('emits offline.html into the build', () => {
    const plugin = offlinePage();
    plugin.configResolved({ root: process.cwd() });
    const emitFile = vi.fn();
    plugin.generateBundle.call({ emitFile });
    expect(emitFile).toHaveBeenCalledWith(expect.objectContaining({ type: 'asset', fileName: OFFLINE_FILENAME }));
    expect(emitFile.mock.calls[0][0].source).toContain('<svg aria-hidden="true" focusable="false"');
  });

  it('serves the page in dev', () => {
    const plugin = offlinePage();
    const use = vi.fn();
    plugin.configureServer({ middlewares: { use } });
    const [route, handler] = use.mock.calls[0];
    const res = { setHeader: vi.fn(), end: vi.fn() };
    handler({}, res);
    expect(route).toBe('/offline.html');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8');
    expect(res.end.mock.calls[0][0]).toContain('Retry connection');
  });
});
