import { describe, expect, it, vi } from 'vitest';
import {
  ASSET_CACHE,
  PAGE_CACHE,
  PRECACHE,
  classifyRequest,
  cleanupCaches,
  handleAsset,
  handleNavigation,
  isCacheable,
  manifestUrls,
  precache,
  staleWhileRevalidate,
} from './core.js';

const ORIGIN = 'https://sendam.test';
const url = (path) => new URL(path, ORIGIN).href;
const keyOf = (request) => new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;

class FakeCache {
  constructor() {
    this.entries = new Map();
  }
  async match(request) {
    const hit = this.entries.get(keyOf(request));
    return hit ? hit.clone() : undefined;
  }
  async put(request, response) {
    this.entries.set(keyOf(request), response.clone());
  }
  async delete(request) {
    return this.entries.delete(keyOf(request));
  }
  async keys() {
    return [...this.entries.keys()].map((href) => new Request(href));
  }
}

class FakeCaches {
  constructor() {
    this.stores = new Map();
  }
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name);
  }
  async match(request, { cacheName } = {}) {
    const names = cacheName ? [cacheName] : [...this.stores.keys()];
    for (const name of names) {
      const hit = await this.stores.get(name)?.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name) {
    return this.stores.delete(name);
  }
}

const page = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const navigate = (path) => {
  const request = new Request(url(path));
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
};
const offline = () => vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
/** Collects waitUntil promises so background revalidation can be awaited. */
const waiter = () => {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
};

describe('classifyRequest', () => {
  it('routes navigations, same-origin static assets and everything else', () => {
    expect(classifyRequest(navigate('/onboarding'), ORIGIN)).toBe('navigation');
    expect(classifyRequest(new Request(url('/assets/index-abc123.js')), ORIGIN)).toBe('asset');
    expect(classifyRequest(new Request(url('/fonts/inter-latin-wght-normal.woff2')), ORIGIN)).toBe('asset');
  });

  it('never intercepts writes, API calls, other origins or the worker script', () => {
    expect(classifyRequest(new Request(url('/assets/a.js'), { method: 'POST' }), ORIGIN)).toBe('bypass');
    expect(classifyRequest(new Request(url('/api/compliance/onboarding')), ORIGIN)).toBe('bypass');
    expect(classifyRequest(new Request('https://cdn.example.com/x.js'), ORIGIN)).toBe('bypass');
    expect(classifyRequest(new Request(url('/sw.js')), ORIGIN)).toBe('bypass');
    expect(classifyRequest(new Request(url('/status')), ORIGIN)).toBe('bypass');
  });
});

describe('isCacheable', () => {
  it('accepts only complete 200 responses', () => {
    expect(isCacheable(new Response('ok'))).toBe(true);
    expect(isCacheable(new Response('', { status: 404 }))).toBe(false);
    expect(isCacheable(new Response('', { status: 206 }))).toBe(false);
    expect(isCacheable(undefined)).toBe(false);
  });
});

describe('staleWhileRevalidate', () => {
  it('serves the cached copy instantly and refreshes it in the background', async () => {
    const caches = new FakeCaches();
    const request = new Request(url('/assets/app-1.js'));
    await (await caches.open(ASSET_CACHE)).put(request, new Response('old'));
    const fetch = vi.fn(async () => new Response('new'));
    const { waitUntil, settle } = waiter();

    const response = await staleWhileRevalidate({ request, cacheName: ASSET_CACHE, caches, fetch, waitUntil });
    expect(await response.text()).toBe('old');
    expect(fetch).toHaveBeenCalledTimes(1);

    await settle();
    expect(await (await caches.match(request)).text()).toBe('new');
  });

  it('fetches and stores on a cache miss', async () => {
    const caches = new FakeCaches();
    const request = new Request(url('/assets/app-2.js'));
    const response = await staleWhileRevalidate({ request, cacheName: ASSET_CACHE, caches, fetch: async () => new Response('fresh') });
    expect(await response.text()).toBe('fresh');
    expect(await (await caches.match(request)).text()).toBe('fresh');
  });

  it('keeps the cached copy when revalidation fails or returns an error status', async () => {
    const caches = new FakeCaches();
    const request = new Request(url('/assets/app-3.js'));
    await (await caches.open(ASSET_CACHE)).put(request, new Response('good'));

    for (const fetch of [offline(), vi.fn(async () => new Response('boom', { status: 500 }))]) {
      const { waitUntil, settle } = waiter();
      const response = await staleWhileRevalidate({ request, cacheName: ASSET_CACHE, caches, fetch, waitUntil });
      expect(await response.text()).toBe('good');
      await settle();
      expect(await (await caches.match(request)).text()).toBe('good');
    }
  });

  it('resolves to undefined with no cache and no network', async () => {
    const response = await staleWhileRevalidate({
      request: new Request(url('/assets/missing.js')),
      cacheName: ASSET_CACHE,
      caches: new FakeCaches(),
      fetch: offline(),
    });
    expect(response).toBeUndefined();
  });
});

describe('handleNavigation', () => {
  it('loads a visited page from cache while checking the network for a new deploy', async () => {
    const caches = new FakeCaches();
    const request = navigate('/onboarding');
    await (await caches.open(PAGE_CACHE)).put(request, page('v1'));
    const { waitUntil, settle } = waiter();

    const response = await handleNavigation({ request, caches, fetch: async () => page('v2'), waitUntil });
    expect(await response.text()).toBe('v1');
    await settle();
    expect(await (await caches.match(request)).text()).toBe('v2');
  });

  it('renders the branded offline page for an uncached route while offline', async () => {
    const caches = new FakeCaches();
    await (await caches.open(PRECACHE)).put('/offline.html', page('offline page'));
    const response = await handleNavigation({ request: navigate('/never-visited'), caches, fetch: offline() });
    expect(await response.text()).toBe('offline page');
  });

  it('serves the precached app shell for the home page while offline', async () => {
    const caches = new FakeCaches();
    const precacheStore = await caches.open(PRECACHE);
    await precacheStore.put('/index.html', page('shell'));
    await precacheStore.put('/offline.html', page('offline page'));
    const response = await handleNavigation({ request: navigate('/'), caches, fetch: offline() });
    expect(await response.text()).toBe('shell');
  });

  it('passes through a real non-OK answer while online', async () => {
    const response = await handleNavigation({
      request: navigate('/missing'),
      caches: new FakeCaches(),
      fetch: async () => page('not found', 404),
    });
    expect(response.status).toBe(404);
  });

  it('returns a network error if even the offline page is missing', async () => {
    const response = await handleNavigation({ request: navigate('/x'), caches: new FakeCaches(), fetch: offline() });
    expect(response.type).toBe('error');
  });
});

describe('handleAsset', () => {
  it('prefers the precached build file', async () => {
    const caches = new FakeCaches();
    await (await caches.open(PRECACHE)).put('/assets/index-abc.js', new Response('precached'));
    const fetch = vi.fn();
    const response = await handleAsset({ request: new Request(url('/assets/index-abc.js')), caches, fetch });
    expect(await response.text()).toBe('precached');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns a network error offline for an asset it never cached', async () => {
    const response = await handleAsset({ request: new Request(url('/assets/gone.js')), caches: new FakeCaches(), fetch: offline() });
    expect(response.type).toBe('error');
  });
});

describe('precache', () => {
  it('normalises manifest entries and always includes the shell and offline page', () => {
    expect(manifestUrls([{ url: 'assets/a.js', revision: null }, 'fonts/x.woff2'])).toEqual([
      '/assets/a.js',
      '/fonts/x.woff2',
      '/index.html',
      '/offline.html',
    ]);
  });

  it('stores every manifest file bypassing the HTTP cache, plus "/" for the shell', async () => {
    const caches = new FakeCaches();
    const fetch = vi.fn(async (path) => new Response(`body of ${path}`));
    await precache({ manifest: [{ url: 'index.html', revision: '1' }, { url: 'assets/a.js', revision: null }], caches, fetch });
    expect(fetch.mock.calls.every(([, init]) => init.cache === 'reload')).toBe(true);
    expect(await (await caches.match('/', { cacheName: PRECACHE })).text()).toBe('body of /index.html');
    expect(await (await caches.match('/offline.html', { cacheName: PRECACHE })).text()).toBe('body of /offline.html');
  });

  it('fails the install when any file cannot be fetched', async () => {
    const fetch = vi.fn(async (path) => (path === '/offline.html' ? new Response('', { status: 404 }) : new Response('ok')));
    await expect(precache({ manifest: [], caches: new FakeCaches(), fetch })).rejects.toThrow(/offline\.html/);
  });
});

describe('cleanupCaches', () => {
  it('removes old versions, stale precache entries, replaced bundles and cached pages', async () => {
    const caches = new FakeCaches();
    await caches.open('sendam-assets-sendam-v1');
    await caches.open('unrelated-cache');
    const pre = await caches.open(PRECACHE);
    await pre.put('/assets/index-new.js', new Response('new'));
    await pre.put('/assets/index-old.js', new Response('old'));
    const assets = await caches.open(ASSET_CACHE);
    await assets.put('/assets/index-old.js', new Response('old'));
    await assets.put('/logo-sent.svg', new Response('logo'));
    await (await caches.open(PAGE_CACHE)).put('/onboarding', page('old html'));

    await cleanupCaches({ manifest: [{ url: 'assets/index-new.js', revision: null }], caches });

    const names = await caches.keys();
    expect(names).not.toContain('sendam-assets-sendam-v1');
    expect(names).not.toContain(PAGE_CACHE);
    expect(names).toContain('unrelated-cache');
    expect(await pre.match('/assets/index-new.js')).toBeDefined();
    expect(await pre.match('/assets/index-old.js')).toBeUndefined();
    expect(await assets.match('/assets/index-old.js')).toBeUndefined();
    expect(await assets.match('/logo-sent.svg')).toBeDefined();
  });
});
