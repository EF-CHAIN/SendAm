import path from 'node:path';

/**
 * Renders the above-the-fold markup through a throwaway Vite SSR server so the
 * build can pick critical CSS from real component output. Returns
 * `{ analysis, shell }`; see src/critical-shell.jsx.
 */
export async function renderAboveTheFold({ root, alias, plugins = [] }) {
  const { createServer } = await import('vite');
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    plugins,
    resolve: { alias, dedupe: ['react', 'react-dom'] },
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    // react-router-dom's default Node entry is CommonJS, which has no named
    // exports under ESM import; its `module-sync` entry is the ESM build.
    ssr: { resolve: { externalConditions: ['module-sync'] } },
  });
  try {
    const mod = await server.ssrLoadModule(path.join(root, 'src/critical-shell.jsx'));
    return {
      analysis: stripHoistedResources(mod.renderCriticalShell()),
      shell: stripHoistedResources(mod.renderNavbarShell()),
    };
  } finally {
    await server.close();
  }
}

// React 19 emits resource hints (e.g. `<link rel="preload">` for images) ahead
// of the markup; they do not belong inside #root.
export function stripHoistedResources(markup) {
  return markup.replace(/<link\b[^>]*\/?>/g, '');
}
