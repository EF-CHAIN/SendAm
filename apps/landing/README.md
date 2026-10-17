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
