import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'prompt',
    includeAssets: ['favicon.svg', 'icons/*.png', 'icons/*.svg'],
    // Single source of truth: the same manifest is served at /manifest.json.
    manifest: JSON.parse(readFileSync(path.resolve(__dirname, 'public/manifest.json'), 'utf8')),
    workbox: {
      globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,woff}'],
      runtimeCaching: [
        {
          urlPattern: /^https:\/\/fonts\./,
          handler: 'CacheFirst',
          options: {
            cacheName: 'sendam-fonts',
            expiration: {
              maxEntries: 10,
              maxAgeSeconds: 365 * 24 * 60 * 60,
            },
          },
        },
        {
          urlPattern: /\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|woff|woff2|ttf|eot)$/,
          handler: 'StaleWhileRevalidate',
          options: {
            cacheName: 'sendam-assets',
          },
        },
        {
          urlPattern: /\.(?:json|xml)$/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'sendam-dynamic',
          },
        },
      ],
      navigateFallback: '/index.html',
      navigateFallbackDenylist: [/\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|woff|woff2|ttf|eot|json|xml)$/],
      cleanupOutdatedCaches: true,
      clientsClaim: true,
      skipWaiting: true,
    },
    devOptions: {
      enabled: true,
      type: 'module',
    },
  })],
  resolve: {
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
  esbuild: process.env.VITEST ? { jsx: 'automatic' } : undefined,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
    exclude: ['**/node_modules/**', '**/e2e/**', '**/dist/**'],
  },
});
