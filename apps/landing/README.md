# SendAm Landing Site

The SendAm landing site is a Vite + React marketing page that introduces the product — WhatsApp-first payments on the Stellar network — and links visitors to the admin dashboard.

Part of the [SendAm](../../README.md) monorepo.

## Pages

```text
/                 Landing page
```

## Environment Variables

Create `apps/landing/.env`:

```env
VITE_ADMIN_URL=http://localhost:3001
```

## Develop

From the repository root:

```bash
npm install
npm run dev:landing   # http://localhost:3000
```

## Build

```bash
npm run build --workspace=apps/landing
```

## Performance and offline

### Fonts

Inter (body) and Outfit (headings) are self-hosted in
[`public/fonts`](public/fonts). Each is a variable-weight (100-900) WOFF2 file
covering the Latin subset only, taken from Fontsource 5.3.0 under the SIL Open
Font License 1.1 (licence files sit next to the fonts).

- [`index.html`](index.html) preloads both files and declares them inline with
  `font-display: swap`. Nothing is requested from Google Fonts, so no
  third-party request can block rendering.
- `Inter Fallback` and `Outfit Fallback` are local Arial faces scaled with
  `size-adjust` and `ascent-override` / `descent-override` to match each web
  font's metrics. Text paints immediately and does not reflow when the web
  font arrives.
- If you replace a font file, recompute those values from the new file's
  average glyph width and vertical metrics.

### Code splitting

[`CurrencyCalculator`](src/components/CurrencyCalculator.jsx) and
[`CorridorGlobe`](src/components/CorridorGlobe.jsx) are separate chunks
([`src/lib/lazySections.js`](src/lib/lazySections.js)).

[`LazySection`](src/components/LazySection.jsx) renders an empty, fixed-height
placeholder with the section's `id` until the section is within 300px of the
viewport, and only then fetches the chunk. This keeps anchor links and layout
stable. A deep link to the section (`/#calculator`) or a browser without
`IntersectionObserver` loads the section at once. A failed chunk load shows a
"Try again" button inside the section instead of the app-wide error screen.

### Service worker

The worker is our own [`src/sw.js`](src/sw.js), with its logic in
[`src/sw/core.js`](src/sw/core.js). vite-plugin-pwa (`injectManifest`) builds
it into `dist/sw.js` and injects the list of build files to precache.

- **Pages:** stale-while-revalidate. A page you have visited opens instantly
  from cache while the network copy is fetched in the background.
- **Offline:** an uncached page while offline gets the branded `offline.html`
  (see below). The home page falls back to the precached app shell.
- **Static assets** (hashed JS/CSS, fonts, icons): precached build files are
  served from cache. Anything else is stale-while-revalidate. API calls,
  non-GET requests and other origins are never intercepted.
- **Updates:** a new deploy installs a new worker, which waits instead of
  taking over. [`UpdatePrompt`](src/components/UpdatePrompt.jsx) then offers
  **Reload**, which activates the new worker and reloads the page.
- **Cache cleanup:** on activation the worker drops older cache versions,
  build files that are no longer in the manifest, and cached pages, which
  reference the previous build's bundles.
- **Offline page:** `offline.html` is generated at build time by
  [`build/offlinePage.js`](build/offlinePage.js) from
  `src/lib/currencyConstants.js`. It is self-contained (inline logo, styles and
  script) and shows the indicative rate table. Its **Retry connection** button
  reloads the page, and it also reloads automatically when the browser comes
  back online. In dev it is served at `/offline.html`.

To try it locally, run `npm run build && npm run preview` in this directory,
load the site once, stop the preview server and open a page you have not
visited.

## Deployment

The landing site builds to static assets, so it deploys to Vercel as a static
site. [`vercel.json`](vercel.json) lives in this directory, and Vercel only
reads `vercel.json` from a project's root directory — so set **Root Directory**
to `apps/landing` for its security headers, SPA fallback rewrite, and
service-worker headers (`dist/sw.js`) to be applied.

```text
Root Directory:    apps/landing
Install Command:   npm install
Build Command:     npm run build      # vite build
Output Directory:  dist
```

Vite replaces `import.meta.env.VITE_*` at build time, so both variables are
baked into the bundle and must be set before the build runs — a restart or a
runtime-only change will not pick them up. Add them under
**Settings → Environment Variables**:

```text
VITE_ADMIN_URL         https://admin.your-domain.com
VITE_WHATSAPP_NUMBER   2348012345678
```

`VITE_ADMIN_URL` falls back to `http://localhost:3001` when unset;
`VITE_WHATSAPP_NUMBER` can stay empty to let WhatsApp pick the chat.

For a custom domain, add it under **Settings → Domains** and point its DNS at
Vercel, which provisions the TLS certificate. `VITE_ADMIN_URL` should then
point at the admin app's own domain, for example
`https://admin.your-domain.com`.

To deploy from the repository root instead, leave Root Directory empty and use:

```text
Build Command:     npm run build --workspace=apps/landing
Output Directory:  apps/landing/dist
```

In that layout Vercel does not read `apps/landing/vercel.json`, so copy it to
the repository root if you need the headers and rewrite there.

## Test

From the repository root:

```bash
npm run test:landing
```

Runs component/smoke tests (navigation, CTAs, FAQ) and `jest-axe` accessibility
checks against the rendered home page with Vitest + Testing Library, in jsdom.
No live services or network access required. CI runs this on every PR via the
`landing-tests` job in [`test.yml`](../../.github/workflows/test.yml).

## Tech Stack

- Vite + React
- React Router
- Tailwind CSS
- Lucide React icons
