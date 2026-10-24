// Landing service worker, built by vite-plugin-pwa (injectManifest) into
// dist/sw.js. Strategies live in ./sw/core.js; see apps/landing/README.md.
import { classifyRequest, cleanupCaches, handleAsset, handleNavigation, precache } from './sw/core.js';

// Replaced at build time with the list of hashed build files to precache.
const MANIFEST = self.__WB_MANIFEST;

self.addEventListener('install', (event) => {
  // No skipWaiting here: an updated worker waits until the page asks it to
  // take over (SKIP_WAITING below), so users are prompted instead of having a
  // new bundle swapped in mid-session.
  event.waitUntil(precache({ manifest: MANIFEST, caches: self.caches, fetch: self.fetch.bind(self) }));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(cleanupCaches({ manifest: MANIFEST, caches: self.caches }).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const kind = classifyRequest(event.request, self.location.origin);
  if (kind === 'bypass') return;
  const deps = {
    request: event.request,
    caches: self.caches,
    fetch: self.fetch.bind(self),
    waitUntil: (promise) => event.waitUntil(promise),
  };
  event.respondWith(kind === 'navigation' ? handleNavigation(deps) : handleAsset(deps));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
