import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXCHANGE_RATES, SOURCE_CURRENCIES, TARGET_CURRENCIES } from '../src/lib/currencyConstants.js';

export const OFFLINE_FILENAME = 'offline.html';

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** Rows of the cached indicative-rate table, one per published corridor. */
export function rateRows(rates = EXCHANGE_RATES, sources = SOURCE_CURRENCIES, targets = TARGET_CURRENCIES) {
  const rows = [];
  for (const source of sources) {
    for (const target of targets) {
      const rate = rates[source.code]?.[target.code];
      if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
        rows.push({ source: source.code, target: target.code, country: target.country, rate });
      }
    }
  }
  return rows;
}

/**
 * Self-contained offline fallback served by the service worker when a page
 * cannot be fetched. No external requests: logo, styles and script are inline
 * so it renders with nothing but this file in the cache.
 */
export function renderOfflinePage({ rates, sources, targets, logoSvg = '' } = {}) {
  const rows = rateRows(rates, sources, targets);
  const tableRows = rows
    .map(
      ({ source, target, country, rate }) =>
        `<tr><td>${escapeHtml(source)} &rarr; ${escapeHtml(target)}</td><td>${escapeHtml(country)}</td><td class="num">${escapeHtml(rate.toLocaleString('en-US'))}</td></tr>`,
    )
    .join('\n          ');
  const table = rows.length
    ? `<table>
        <caption>Indicative rates saved for offline viewing. Live quotes need a connection.</caption>
        <thead><tr><th scope="col">Corridor</th><th scope="col">Country</th><th scope="col" class="num">1 unit =</th></tr></thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>`
    : '<p class="muted">Rates are unavailable offline.</p>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0d9488" />
    <meta name="robots" content="noindex" />
    <title>You're offline | SendAm</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px;
        font-family: Inter, 'Inter Fallback', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif; color: #0f172a; background: #f0fdfa; }
      main { width: 100%; max-width: 520px; background: #fff; border: 1px solid #e2e8f0; border-radius: 24px; padding: 32px 24px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
      .brand { display: flex; align-items: center; gap: 8px; color: #0d9488; font-weight: 700; font-size: 20px; }
      .brand svg { width: 28px; height: 28px; }
      h1 { margin: 24px 0 8px; font-size: 26px; line-height: 1.2; }
      p { margin: 0 0 16px; line-height: 1.5; color: #475569; }
      button { display: inline-flex; align-items: center; justify-content: center; width: 100%; min-height: 48px; border: 0; border-radius: 12px;
        background: #0d9488; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
      button:hover { background: #0f766e; }
      button:focus-visible { outline: 3px solid #14b8a6; outline-offset: 2px; }
      table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 14px; }
      caption { text-align: left; color: #64748b; font-size: 13px; margin-bottom: 8px; }
      th, td { padding: 8px 4px; border-bottom: 1px solid #f1f5f9; text-align: left; }
      th { color: #64748b; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .muted { color: #64748b; font-size: 14px; }
      .status { min-height: 1.5em; margin-top: 12px; font-size: 14px; text-align: center; }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">${logoSvg}<span>SendAm</span></div>
      <h1>You're offline</h1>
      <p>This page isn't saved on your device yet. Check your connection and try again. Pages you have already visited still work offline.</p>
      <button type="button" id="retry">Retry connection</button>
      <p class="status" id="status" role="status" aria-live="polite"></p>
      ${table}
    </main>
    <script>
      (function () {
        var status = document.getElementById('status');
        function retry() {
          if (navigator.onLine === false) {
            status.textContent = 'Still offline. We will reload as soon as you are back online.';
            return;
          }
          status.textContent = 'Reconnecting...';
          window.location.reload();
        }
        document.getElementById('retry').addEventListener('click', retry);
        window.addEventListener('online', retry);
      })();
    </script>
  </body>
</html>
`;
}

function readLogo(root) {
  try {
    return readFileSync(path.join(root, 'public/logo-sent-mark.svg'), 'utf8')
      .replace(/<\?xml[^>]*>\s*/g, '')
      .replace('<svg', '<svg aria-hidden="true" focusable="false"');
  } catch {
    return '';
  }
}

/**
 * Vite plugin: emits dist/offline.html (precached by the service worker) and
 * serves the same page at /offline.html in dev.
 */
export default function offlinePage() {
  let root = process.cwd();
  const render = () => renderOfflinePage({ logoSvg: readLogo(root) });
  return {
    name: 'sendam:offline-page',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use(`/${OFFLINE_FILENAME}`, (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(render());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: OFFLINE_FILENAME, source: render() });
    },
  };
}
