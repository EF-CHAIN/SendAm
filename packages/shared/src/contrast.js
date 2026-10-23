/**
 * Browser-safe WCAG colour contrast helpers.
 *
 * Kept free of Node-only imports so the dev-mode checker can ship in the Vite
 * bundles. The Node-side audit harness (a11yAudit.js) re-exports these.
 */

export const WCAG_AA_NORMAL_TEXT = 4.5;

const linearise = (channel) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.x relative luminance of a hex colour (`#rgb` or `#rrggbb`). */
export const relativeLuminance = (hex) => {
  const digits = String(hex).replace('#', '').trim();
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((c) => c + c)
          .join('')
      : digits;
  const [r, g, b] = [0, 2, 4].map((i) => linearise(parseInt(full.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two hex colours, from 1 to 21. */
export const contrastRatio = (a, b) => {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * Parse a computed CSS colour (`rgb(r, g, b)` or `rgba(r, g, b, a)`) into
 * channels. Returns null for anything else, such as `transparent` or `oklch()`.
 */
export function parseRgb(value) {
  const match = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+(\d*\.?\d+%?))?\s*\)$/.exec(
    String(value).trim(),
  );
  if (!match) return null;
  let alpha = 1;
  if (match[4] !== undefined) {
    alpha = match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]);
  }
  return {
    r: Math.round(Number(match[1])),
    g: Math.round(Number(match[2])),
    b: Math.round(Number(match[3])),
    a: alpha,
  };
}

const toHex = ({ r, g, b }) =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

const isTransparent = (rgb) => !rgb || rgb.a === 0;

/**
 * Find text-bearing elements under `root` whose computed foreground colour
 * fails the given contrast threshold against the nearest opaque background.
 *
 * Only elements with their own non-whitespace text node are checked, so a
 * wrapper does not get reported for text that belongs to its children.
 * Backgrounds with partial alpha are treated as opaque; images and gradients
 * are not sampled, so those elements are skipped rather than guessed at.
 */
export function findLowContrastElements(root, { threshold = WCAG_AA_NORMAL_TEXT, view } = {}) {
  const win = view || root.ownerDocument?.defaultView || window;
  const failures = [];

  for (const el of root.querySelectorAll('*')) {
    const hasOwnText = Array.from(el.childNodes).some(
      (node) => node.nodeType === 3 && node.textContent.trim() !== '',
    );
    if (!hasOwnText) continue;

    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    const foreground = parseRgb(style.color);
    if (!foreground || isTransparent(foreground)) continue;

    let background = null;
    let node = el;
    while (node) {
      const candidate = parseRgb(win.getComputedStyle(node).backgroundColor);
      if (!isTransparent(candidate)) {
        background = candidate;
        break;
      }
      node = node.parentElement;
    }
    if (!background) continue;

    const ratio = contrastRatio(toHex(foreground), toHex(background));
    if (ratio < threshold) {
      failures.push({
        element: el,
        description: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`,
        ratio: Math.round(ratio * 100) / 100,
        required: threshold,
        foreground: toHex(foreground),
        background: toHex(background),
      });
    }
  }

  return failures;
}

/**
 * Dev-only: after the page settles, log a grouped console warning for every
 * text element that fails WCAG AA. Does nothing outside dev builds.
 */
export function startDevContrastCheck({ root, delay = 1000, devMode = false, logger = console } = {}) {
  if (!devMode) return null;
  const target = root || (typeof document !== 'undefined' ? document.body : null);
  if (!target) return null;

  const timer = setTimeout(() => {
    const failures = findLowContrastElements(target);
    if (failures.length === 0) return;

    logger.groupCollapsed(
      `[a11y] ${failures.length} text element(s) fail WCAG AA contrast (4.5:1)`,
    );
    for (const failure of failures) {
      logger.warn(
        `${failure.description} contrast ${failure.ratio}:1 (needs ${failure.required}:1) ` +
          `text ${failure.foreground} on ${failure.background}`,
        failure.element,
      );
    }
    logger.groupEnd();
  }, delay);

  return () => clearTimeout(timer);
}
