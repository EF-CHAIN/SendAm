import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'prompt',
    includeAssets: ['favicon.svg', 'icons/*.png', 'icons/*.svg'],
    manifest: {
      name: 'SendAm',
      short_name: 'SendAm',
      description: 'Send money like you send a text. WhatsApp-first payments powered by the Stellar network.',
      theme_color: '#0d9488',
      background_color: '#0d9488',
      display: 'standalone',
      orientation: 'portrait-primary',
      start_url: '/',
      scope: '/',
      lang: 'en',
      dir: 'ltr',
      categories: ['finance', 'social'],
      icons: [
        { src: '/icons/icon-72x72.png', sizes: '72x72', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-96x96.png', sizes: '96x96', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-128x128.png', sizes: '128x128', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-144x144.png', sizes: '144x144', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-152x152.png', sizes: '152x152', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icons/icon-384x384.png', sizes: '384x384', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
      screenshots: [
        { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png', form_factor: 'narrow', label: 'SendAm Home Screen' },
        { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png', form_factor: 'wide', label: 'SendAm Desktop View' },
      ],
      shortcuts: [
        {
          name: 'Send Money',
          short_name: 'Send',
          description: 'Send money via WhatsApp',
          url: '/',
          icons: [{ src: '/icons/icon-192x192.png', sizes: '192x192' }],
        },
        {
          name: 'Check Balance',
          short_name: 'Balance',
          description: 'Check your XLM balance',
          url: '/',
          icons: [{ src: '/icons/icon-192x192.png', sizes: '192x192' }],
        },
      ],
    },
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
