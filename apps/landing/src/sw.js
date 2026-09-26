const CACHE_VERSION = 'sendam-v1';
const ASSET_CACHE = `sendam-assets-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `sendam-dynamic-${CACHE_VERSION}`;
const PAGE_CACHE = `sendam-pages-${CACHE_VERSION}`;
const FONT_CACHE = `sendam-fonts-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/index.html',
];

const ASSET_PATTERN = /\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|woff|woff2|ttf|eot)$/;
const FONT_PATTERN = /^https:\/\/fonts\./;
const JSON_PATTERN = /\.(?:json|xml)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(ASSET_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => !name.endsWith(CACHE_VERSION))
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, PAGE_CACHE));
    return;
  }

  if (FONT_PATTERN.test(request.url)) {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  if (ASSET_PATTERN.test(request.url)) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
    return;
  }

  if (JSON_PATTERN.test(request.url)) {
    event.respondWith(networkFirst(request, DYNAMIC_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
});

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then((cache) => {
    return cache.match(request).then((cached) => {
      const fetched = fetch(request).then((response) => {
        if (response && response.status === 200) {
          cache.put(request, response.clone());
        }
        return response;
      }).catch(() => cached);
      return cached || fetched;
    });
  });
}

function networkFirst(request, cacheName) {
  return caches.open(cacheName).then((cache) => {
    return fetch(request).then((response) => {
      if (response && response.status === 200) {
        cache.put(request, response.clone());
      }
      return response;
    }).catch(() => {
      return cache.match(request).then((cached) => {
        if (cached) return cached;
        return caches.open(ASSET_CACHE).then((c) => c.match('/index.html'));
      });
    });
  });
}

function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then((cache) => {
    return cache.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.status === 200) {
          cache.put(request, response.clone());
        }
        return response;
      });
    });
  });
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
