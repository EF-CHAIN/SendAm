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
