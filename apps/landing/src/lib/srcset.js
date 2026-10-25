// Helpers for responsive image markup.

const isValidWidth = (w) => Number.isInteger(w) && w > 0;

/**
 * Build a `srcset` string, e.g. `/img/a-600.avif 600w, /img/a-1200.avif 1200w`.
 * Returns '' when there is nothing valid to describe.
 */
export function buildSrcSet(basePath, widths, format) {
  if (!basePath || !Array.isArray(widths)) return '';
  return widths
    .filter(isValidWidth)
    .map((w) => `${basePath}-${w}.${format} ${w}w`)
    .join(', ');
}
