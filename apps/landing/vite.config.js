import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
    port: 3000,
    headers: {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none';",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
    }
  },
  // @vitejs/plugin-react 6 configures JSX via Vite's newer `oxc.jsx` hook,
  // which Vitest's test transform pipeline doesn't pick up (it falls back to
  // esbuild's own classic transform, which expects a global `React`). This
  // stable esbuild option keeps .jsx files on the automatic runtime under
  // Vitest; scoped to `process.env.VITEST` so `vite dev`/`vite build` keep
  // using the plugin's own (newer, oxc-based) JSX handling untouched.
  esbuild: process.env.VITEST ? { jsx: 'automatic' } : undefined,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
  },
});
