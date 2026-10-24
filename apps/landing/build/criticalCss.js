import path from 'node:path';
import Beasties from 'beasties';

const ROOT_PATTERN = /<div id="root"><\/div>/;

/**
 * Beasties reads stylesheets from disk by default. During `vite build` the CSS
 * only exists in the in-memory bundle, so resolve stylesheet reads against it.
 */
class BundleBeasties extends Beasties {
  constructor(options, cssAssets) {
    super(options);
    this.cssAssets = cssAssets;
  }

  readFile(filename) {
    const name = path.basename(filename);
    const match = Object.entries(this.cssAssets).find(([fileName]) => path.basename(fileName) === name);
    if (!match) {
      throw new Error(`critical-css: stylesheet ${name} is not in the build output`);
    }
    return match[1];
  }
}

/** Collects `{ fileName: source }` for every emitted CSS asset in a Rollup bundle. */
export function collectCssAssets(bundle = {}) {
  const assets = {};
  for (const output of Object.values(bundle)) {
    if (output?.type === 'asset' && output.fileName.endsWith('.css')) {
      assets[output.fileName] =
        typeof output.source === 'string' ? output.source : Buffer.from(output.source).toString('utf8');
    }
  }
  return assets;
}

/**
 * Inlines the CSS rules used by `analysisMarkup` into a `<style>` tag in the
 * head and turns every same-origin stylesheet link into a non-blocking load
 * (`media="print"` swapped to `all` on load, with a `<noscript>` fallback).
 *
 * `analysisMarkup` is rendered into `#root` only while selecting rules. The
 * shipped HTML gets `shellMarkup` instead (empty string keeps `#root` empty).
 * Any failure returns the original HTML so a build never breaks on this step.
 */
export async function inlineCriticalCss({
  html,
  cssAssets,
  analysisMarkup = '',
  shellMarkup = '',
  base = '/',
  logger = console,
}) {
  if (!Object.keys(cssAssets).length || !ROOT_PATTERN.test(html)) return html;

  try {
    const beasties = new BundleBeasties(
      {
        path: '/',
        publicPath: base,
        preload: 'media',
        noscriptFallback: true,
        pruneSource: false,
        inlineFonts: false,
        reduceInlineStyles: false,
        logLevel: 'silent',
      },
      cssAssets,
    );
    const analysed = html.replace(ROOT_PATTERN, `<div id="root">${analysisMarkup}</div>`);
    const processed = await beasties.process(analysed);
    if (!/<style[^>]*>/.test(processed)) {
      throw new Error('no critical rules were inlined');
    }
    return replaceRootContent(processed, shellMarkup);
  } catch (error) {
    logger.warn(`[critical-css] skipped, stylesheet left render-blocking: ${error.message}`);
    return html;
  }
}

// Replaces whatever is inside #root with `content`.
export function replaceRootContent(html, content) {
  const open = '<div id="root">';
  const start = html.indexOf(open);
  if (start === -1) throw new Error('#root not found');
  const inner = html.slice(start + open.length);
  const close = findMatchingClose(inner);
  return `${html.slice(0, start)}${open}${content}</div>${inner.slice(close + '</div>'.length)}`;
}

// Index of the `</div>` closing the element whose children start at `markup[0]`.
function findMatchingClose(markup) {
  const tag = /<div\b[^>]*>|<\/div>/g;
  let depth = 0;
  let match;
  while ((match = tag.exec(markup)) !== null) {
    if (match[0] === '</div>') {
      if (depth === 0) return match.index;
      depth -= 1;
    } else if (!match[0].endsWith('/>')) {
      depth += 1;
    }
  }
  throw new Error('unbalanced #root markup');
}

/**
 * Vite plugin: at build time, inline above-the-fold CSS into index.html and
 * load the full Tailwind stylesheet asynchronously. No effect in dev.
 *
 * `renderMarkup()` resolves to `{ analysis, shell }` HTML strings; a failure
 * there degrades to selecting rules from the empty document.
 */
export default function criticalCss({ renderMarkup = async () => ({ analysis: '', shell: '' }) } = {}) {
  let base = '/';
  let logger = console;
  return {
    name: 'sendam:critical-css',
    apply: 'build',
    configResolved(config) {
      base = config.base;
      logger = config.logger;
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html, ctx) {
        const cssAssets = collectCssAssets(ctx.bundle);
        let markup = { analysis: '', shell: '' };
        try {
          markup = await renderMarkup();
        } catch (error) {
          logger.warn(`[critical-css] above-the-fold render failed: ${error.message}`);
        }
        return inlineCriticalCss({
          html,
          cssAssets,
          analysisMarkup: markup.analysis,
          shellMarkup: markup.shell,
          base,
          logger,
        });
      },
    },
  };
}
