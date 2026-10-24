// Pixel-diff tolerance for the landing visual regression suite (#826).
// Override with VISUAL_MAX_DIFF_PIXEL_RATIO, e.g. 0.0002 for 0.02%.
export const DEFAULT_MAX_DIFF_PIXEL_RATIO = 0.0005;
// Regressions must be caught below 0.1% of changed pixels.
export const MAX_ALLOWED_DIFF_PIXEL_RATIO = 0.001;

/**
 * Reads the max diff pixel ratio from the environment. Anything that is not a
 * number in (0, 0.001) is a configuration error, so fail loudly instead of
 * silently loosening the gate.
 */
export function resolveMaxDiffPixelRatio(env = process.env) {
  const raw = env.VISUAL_MAX_DIFF_PIXEL_RATIO;
  if (raw === undefined || raw === '') return DEFAULT_MAX_DIFF_PIXEL_RATIO;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= MAX_ALLOWED_DIFF_PIXEL_RATIO) {
    throw new Error(
      `VISUAL_MAX_DIFF_PIXEL_RATIO must be a number greater than 0 and below ${MAX_ALLOWED_DIFF_PIXEL_RATIO} (got "${raw}")`,
    );
  }
  return value;
}
