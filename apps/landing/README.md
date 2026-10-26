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
### Critical CSS

The build inlines the CSS needed for the first viewport and stops the full
Tailwind stylesheet from blocking first paint
([`build/criticalCss.js`](build/criticalCss.js)):

1. `build/renderShell.js` renders the navbar and hero
   ([`src/critical-shell.jsx`](src/critical-shell.jsx)) through a temporary
   Vite SSR server.
2. [Beasties](https://github.com/danielroe/beasties) keeps only the rules that
   markup uses and inlines them in a `<style>` tag in `index.html`
   (about 15 kB of the 45 kB stylesheet).
3. The full stylesheet is loaded with `media="print"` and switched to `all`
   on load, with a `<noscript>` fallback. Google Fonts load the same way.
4. The static navbar markup ships inside `#root`, so the first paint happens
   before the JS bundle runs. React replaces it on mount.

If any step fails, the build logs a `[critical-css]` warning and keeps the
original render-blocking stylesheet rather than shipping unstyled HTML. The
step only runs for `vite build`; the dev server is unchanged.

To check First Contentful Paint against the 0.8 s target, run Lighthouse on
the production build with mobile throttling:

```bash
npm run build --workspace=apps/landing
npm run preview --workspace=apps/landing -- --port 4173
npx lighthouse http://localhost:4173 --only-categories=performance --form-factor=mobile --throttling-method=simulate
```

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

## Hero images

The hero phone wallpaper is served through `ResponsivePicture`
([`src/components/ResponsivePicture.jsx`](src/components/ResponsivePicture.jsx)):
a `<picture>` with AVIF, then WebP, then the original `whatsapp-bg.png` as the
fallback `<img>`. Variants are described with width descriptors
(`srcset="... 600w, ... 1200w, ... 1800w"`, `sizes="600px"`), so a phone picks
the 600px file at 1x and the 1200px file at 2x. The manifest lives in
[`src/lib/heroImages.js`](src/lib/heroImages.js); files live in
`public/img/hero-wallpaper-<width>.<avif|webp>`.

`Hero` passes `priority` down to the wallpaper, which sets `loading="eager"`
and `fetchpriority="high"`; every other use defaults to lazy loading. Mobile
1x and 2x variants are asserted to stay under 100KB in
`ResponsivePicture.test.jsx`.

To regenerate the variants from `public/whatsapp-bg.png` (Pillow 11.3+):

```bash
python3 - <<'PY'
from PIL import Image
src = Image.open("public/whatsapp-bg.png").convert("RGBA")
for w in (600, 1200, 1800):
    im = src.resize((w, w), Image.LANCZOS)
    im.save(f"public/img/hero-wallpaper-{w}.webp", quality=82, method=6)
    im.save(f"public/img/hero-wallpaper-{w}.avif", quality=60, speed=4)
PY
```

## Structured data

`index.html` carries one schema.org JSON-LD block (`#sendam-structured-data`)
with an `Organization` and a `FinancialService` node. `areaServed` mirrors the
calculator corridors and `currenciesAccepted` mirrors the source currencies in
`src/lib/currencyConstants.js`; `src/test/structured-data.test.js` fails when
they drift. Validate changes with Google's Rich Results Test or the Schema.org
validator after deploying.

## Calculator rendering priority

`CurrencyCalculator` keeps the amount field urgent and derives the quote from
`useDeferredValue` copies of the amount and currencies, so typing is never
blocked by the fee maths or locale formatting. Corridor tabs and quick-amount
presets update inside `startTransition`. The output column is memoised and sets
`aria-busy` / `data-stale` while it catches up. The maths itself lives in
[`src/lib/quote.js`](src/lib/quote.js). Measure INP with Chrome DevTools
Performance (CPU 6x slowdown) or Lighthouse timespan mode.
## Security Headers And CSP

The landing site sends a strict Content Security Policy (CSP) plus four
companion headers. They are declared in two places, one per environment:

| Environment | Declared in | Scope |
| --- | --- | --- |
| `npm run dev:landing` | `server.headers` in [`vite.config.js`](vite.config.js) | every dev-server response on `http://localhost:3000` |
| Deployed site | `headers` in [`vercel.json`](vercel.json) | every response, plus two per-path rules |

Vercel reads `vercel.json` only from the project root directory, so the
deployed headers require **Root Directory** set to `apps/landing` as described
in [Deployment](#deployment).

To see what the dev server actually sends:

```bash
npm run dev:landing
curl -I http://localhost:3000/
```

### Directives

| Directive | Value | Purpose |
| --- | --- | --- |
| `default-src` | `'self'` | fallback for any fetch type not listed below |
| `script-src` | `'self' 'unsafe-inline'` | bundled modules plus the inline React Refresh preamble Vite injects in dev |
| `style-src` | `'self' 'unsafe-inline' https://fonts.googleapis.com` | Tailwind output, inline `style={{}}` props, Google Fonts stylesheet |
| `font-src` | `'self' https://fonts.gstatic.com` | Inter webfont files |
| `img-src` | `'self' data:` | bundled assets and inline data-URL images |
| `connect-src` | `'self'` (deployed) / `'self' ws: wss:` (dev) | fetch/XHR/EventSource; dev adds the HMR web socket |
| `frame-ancestors` | `'none'` | the site cannot be embedded in a frame |
| `base-uri` | `'none'` | blocks `<base>` hijacking of relative URLs |
| `form-action` | `'none'` | no form can submit off-origin |
| `upgrade-insecure-requests` | deployed only | rewrites `http://` subresources to `https://` |

The non-CSP headers are the same in both environments:
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, and
`Permissions-Policy: geolocation=(), microphone=(), camera=()`.

### Local vs deployed differences

| Behaviour | Dev server | Deployed (Vercel) |
| --- | --- | --- |
| `connect-src` | `'self' ws: wss:` | `'self'` |
| `upgrade-insecure-requests` | absent | present |
| `/sw.js` | falls back to `index.html` (`Content-Type: text/html`) | served as JavaScript with `Service-Worker-Allowed: /` |
| `/manifest.json` | `Content-Type: application/json` | `Content-Type: application/manifest+json` |

Only the deployed site applies the two per-path rules in `vercel.json`, so
service-worker behaviour has to be verified there rather than against the dev
server.

### Allowing another origin

Anything the page fetches — a local backend proxy, a webhook receiver, an
analytics beacon — must be listed in `connect-src`, otherwise the browser
blocks the request and logs a CSP violation in the console. The policy exists
twice, so add the origin to **both** files or it will work in one environment
and fail in the other:

1. `apps/landing/vite.config.js` — `server.headers['Content-Security-Policy']`
2. `apps/landing/vercel.json` — the `Content-Security-Policy` header under `headers`

To let the page call the API while developing, widen `connect-src` to
`'self' ws: wss: http://localhost:3002`; for the deployed site use the API's
own HTTPS origin, for example `'self' https://api.your-domain.com` (do not add
`http://` origins to the deployed policy). The same pattern applies to the
other fetch types: `img-src` for remote images, `style-src` for a remote
stylesheet, `font-src` for a remote font.

Vite watches its own config, so saving `vite.config.js` restarts the server and
picks up the new header — the log prints `vite.config.js changed, restarting
server...`. Deployed header changes take effect on the next Vercel deployment.

## Test

From the repository root:

```bash
npm run test:landing
```

Runs component/smoke tests (navigation, CTAs, FAQ) and `jest-axe` accessibility
checks against the rendered home page with Vitest + Testing Library, in jsdom.
No live services or network access required. CI runs this on every PR via the
`landing-tests` job in [`test.yml`](../../.github/workflows/test.yml).

### End-to-end (Playwright)

```bash
npx playwright install chromium        # once per machine
npm run test:e2e:landing -- --project=chromium
```

- `e2e/landing-journey.spec.js`: smoke journey.
- `e2e/calculator.spec.js`: the currency calculator across 10 preset scenarios.
  These cover all 9 published corridors (USD, GBP, EUR to NGN, KES, GHS), each
  preset amount, and a typed amount. The tests check the 1% fee, the
  traditional-fee comparison and the payout, plus corridor tab switching,
  input validation, and that the WhatsApp link carries the typed amount.
  Expected values are written out by hand from the rate table.

### Visual regression

```bash
npm run test:visual -- --project=landing-desktop-chrome --project=landing-ipad-mini --project=landing-iphone-14
```

`e2e/visual-regression.spec.js` runs from the root `playwright.config.js`
under Desktop Chrome, iPad Mini and iPhone 14 profiles, all rendered with
Chromium. For the home, onboarding status and not-found pages it compares a
full-page screenshot and asserts there is no horizontal overflow.

- **Threshold:** `VISUAL_MAX_DIFF_PIXEL_RATIO` sets the threshold. The default
  is `0.0005` (0.05%); any value at or above 0.1% is rejected.
- **Determinism:** remote fonts are blocked, motion is reduced and the
  onboarding API is mocked, so screenshots are stable between runs.
- **Diff artifacts:** on failure, Playwright writes expected, actual and diff
  images to `test-results/` and the HTML report. CI uploads both as the
  `playwright-visual-diffs` artifact.
- **Baselines:** baselines are rendered on the CI runner. Run the *Visual
  Regression Tests* workflow with `update_snapshots=true`, download the
  `visual-baselines` artifact, and commit the PNGs.

## Tech Stack

- Vite + React
- React Router
- Tailwind CSS
- Lucide React icons
