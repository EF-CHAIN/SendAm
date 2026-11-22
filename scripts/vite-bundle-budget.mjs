/**
 * Rollup/Vite build plugin that fails the production build when any initial
 * entry chunk exceeds the configured size budget (default: 250 KB).
 *
 * @param {object} [options]
 * @param {number} [options.maxEntryKb=250] - Maximum allowed size (raw KB) for entry chunks.
 * @returns {import('vite').Plugin}
 */
export function enforceEntryChunkBudget({ maxEntryKb = 250 } = {}) {
  const maxBytes = maxEntryKb * 1024;
  return {
    name: 'sendam-entry-chunk-budget',
    apply: 'build',
    generateBundle(_outputOptions, bundle) {
      const violations = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !output.isEntry) continue;
        const bytes = Buffer.byteLength(output.code, 'utf8');
        if (bytes > maxBytes) {
          const kb = (bytes / 1024).toFixed(2);
          violations.push(
            `Initial entry chunk "${output.fileName}" is ${kb} KB, exceeding the ${maxEntryKb} KB budget.`
          );
        }
      }
      if (violations.length > 0) {
        this.error(violations.join('\n'));
      }
    },
  };
}

/**
 * Shared Rollup manualChunks splitter that keeps React framework dependencies
 * in a dedicated cacheable vendor chunk so initial application entry chunks
 * stay well under the 250 KB budget without adding multi-chunk overhead.
 */
export function splitVendorChunks(id) {
  if (!id.includes('node_modules')) return undefined;
  if (
    id.includes('react-router') ||
    id.includes('/react-dom/') ||
    id.includes('\\react-dom\\') ||
    id.includes('/react/') ||
    id.includes('\\react\\') ||
    id.includes('/scheduler/') ||
    id.includes('\\scheduler\\')
  ) {
    return 'vendor-react';
  }
  return undefined;
}
