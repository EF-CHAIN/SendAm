// Pure caching logic for the landing service worker (src/sw.js). Everything
// the worker touches (Cache Storage, fetch, waitUntil) is passed in, so the
// strategies can be unit tested without a real ServiceWorkerGlobalScope.

export const CACHE_VERSION = 'v2';
export const PRECACHE = `sendam-precache-${CACHE_VERSION}`;
export const PAGE_CACHE = `sendam-pages-${CACHE_VERSION}`;
export const ASSET_CACHE = `sendam-assets-${CACHE_VERSION}`;
export const CURRENT_CACHES = [PRECACHE, PAGE_CACHE, ASSET_CACHE];

export const OFFLINE_URL = '/offline.html';
export const APP_SHELL_URL = '/index.html';

const STATIC_ASSET = /\.(?:js|mjs|css|woff2?|png|jpe?g|gif|svg|webp|ico|webmanifest|json)$/;

/**
 * Decides how a request is served:
 * - `navigation`: page loads, stale-while-revalidate with an offline fallback;
 * - `asset`: same-origin static files (hashed bundles, fonts, icons),
 *   stale-while-revalidate;
 * - `bypass`: everything else (non-GET, cross-origin, API calls, the worker
 *   script itself), left to the network untouched.
 */
export function classifyRequest(request, origin) {
  if (request.method !== 'GET') return 'bypass';
  const url = new URL(request.url);
  if (url.origin !== origin) return 'bypass';
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return 'bypass';
  if (request.mode === 'navigate') return 'navigation';
  if (STATIC_ASSET.test(url.pathname)) return 'asset';
  return 'bypass';
}

/** Only complete, same-origin (or CORS) 200 responses are worth caching. */
export function isCacheable(response) {
  return Boolean(response) && response.status === 200 && (response.type === 'basic' || response.type === 'cors' || response.type === 'default');
}

/**
 * Stale-while-revalidate: answer from the cache immediately when possible and
 * refresh the entry from the network in the background (kept alive with
 * `waitUntil`). With no cached copy the network response is returned and
 * stored. Resolves to `undefined` when neither is available.
 */
export async function staleWhileRevalidate({ request, cacheName, caches, fetch, waitUntil = () => {} }) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const revalidate = fetch(request)
    .then(async (response) => {
      if (isCacheable(response)) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    waitUntil(revalidate);
    return cached;
  }
  return revalidate;
}

/**
 * Page loads: a previously visited page (or the precached app shell for "/")
 * renders instantly from cache and is revalidated in the background, so a new
 * deploy is picked up on the next visit. An uncached page goes to the network;
 * if that fails (offline), the precached branded offline page is returned
 * instead of the browser's network error.
 */
export async function handleNavigation({ request, caches, fetch, waitUntil }) {
  const url = new URL(request.url);
  const shellKey = url.pathname === '/' ? APP_SHELL_URL : null;

  const response = await staleWhileRevalidate({ request, cacheName: PAGE_CACHE, caches, fetch, waitUntil });
  if (response && response.ok) return response;

  if (shellKey) {
    const shell = await caches.match(shellKey);
    if (shell) return shell;
  }
  // A non-OK network answer (e.g. 404) is still a real answer while online.
  if (response) return response;

  const offline = await caches.match(OFFLINE_URL);
  return offline || Response.error();
}

/** Serves a static asset; falls back to a network error rather than hanging. */
export async function handleAsset({ request, caches, fetch, waitUntil }) {
  const precached = await caches.match(request, { cacheName: PRECACHE });
  if (precached) return precached;
  const response = await staleWhileRevalidate({ request, cacheName: ASSET_CACHE, caches, fetch, waitUntil });
  return response || Response.error();
}

/** Normalises the build manifest (`self.__WB_MANIFEST`) into absolute paths. */
export function manifestUrls(manifest = []) {
  const urls = manifest.map((entry) => (typeof entry === 'string' ? entry : entry.url)).map((url) => (url.startsWith('/') ? url : `/${url}`));
  for (const required of [APP_SHELL_URL, OFFLINE_URL]) {
    if (!urls.includes(required)) urls.push(required);
  }
  return [...new Set(urls)];
}

/**
 * Install step: fetch every manifest entry bypassing the HTTP cache. A single
 * failure rejects, so a broken deploy never activates half a precache.
 */
export async function precache({ manifest, caches, fetch }) {
  const cache = await caches.open(PRECACHE);
  const urls = manifestUrls(manifest);
  await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url, { cache: 'reload' });
      if (!isCacheable(response)) throw new Error(`precache failed for ${url} (${response && response.status})`);
      await cache.put(url, response);
    }),
  );
  // "/" renders the same document as /index.html.
  const shell = await cache.match(APP_SHELL_URL);
  if (shell) await cache.put('/', shell.clone());
  return urls;
}

/**
 * Activate step: drop caches from older worker versions, precache entries that
 * are no longer in the manifest, and runtime copies of hashed bundles that
 * the new build replaced. Cached pages are cleared too: they reference the
 * previous build's bundles, so the next navigation fetches fresh HTML.
 */
export async function cleanupCaches({ manifest, caches }) {
  const keep = new Set([...manifestUrls(manifest), '/']);
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith('sendam-') && (!CURRENT_CACHES.includes(name) || name === PAGE_CACHE))
      .map((name) => caches.delete(name)),
  );

  for (const name of [PRECACHE, ASSET_CACHE]) {
    if (!names.includes(name)) continue;
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const { pathname } = new URL(request.url);
      const stale = name === PRECACHE ? !keep.has(pathname) : pathname.startsWith('/assets/') && !keep.has(pathname);
      if (stale) await cache.delete(request);
    }
  }
}
