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

## Tech Stack

- Vite + React
- React Router
- Tailwind CSS
- Lucide React icons
