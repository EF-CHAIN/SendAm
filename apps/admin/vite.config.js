import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { visualizer } from 'rollup-plugin-visualizer';
import { enforceEntryChunkBudget, splitVendorChunks } from '../../scripts/vite-bundle-budget.mjs';

const MAX_ENTRY_CHUNK_KB = 250;

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    visualizer({
      filename: path.resolve(__dirname, 'dist/stats.html'),
      title: 'SendAm Admin Bundle Analysis',
      template: 'treemap',
      gzipSize: true,
      brotliSize: true,
      open: false,
    }),
    enforceEntryChunkBudget({ maxEntryKb: MAX_ENTRY_CHUNK_KB }),
  ],
  build: {
    chunkSizeWarningLimit: MAX_ENTRY_CHUNK_KB,
    rollupOptions: {
      output: {
        manualChunks: splitVendorChunks,
      },
    },
  },
  resolve: {
    // Force a single React copy. In this workspace react-router-dom can be
    // hoisted to the root node_modules and resolve a different React than the
    // app, which triggers "Invalid hook call". dedupe pins one copy.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  server: {
    port: 3001,
    headers: {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' http: https: ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none';",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
    }
  },
  esbuild: process.env.VITEST ? { jsx: 'automatic' } : undefined,
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.js',
    exclude: ['**/node_modules/**', '**/e2e/**', '**/dist/**'],
  },
});
