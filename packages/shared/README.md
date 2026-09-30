# @sendam/shared

Shared UI components, utilities, and the API client used by the SendAm frontend workspaces (`apps/landing` and `apps/admin`).

Part of the [SendAm](../../README.md) monorepo.

## What's in here

| File | Export | Purpose |
| --- | --- | --- |
| `src/Loader.jsx` | `default` | Inline loading spinner |
| `src/ErrorBoundary.jsx` | `default` | React error boundary that renders a safe recovery UI |
| `src/ErrorFallback.jsx` | `default` | Recovery UI shown by `ErrorBoundary` |
| `src/formatDate.js` | `formatDate` | Locale-aware date/time formatting |
| `src/normalizeError.js` | `normalizeError` | Turns any thrown value into a safe, structured error |
| `src/logger.js` | `logger`, `redact` | Structured console logging with secret redaction |
| `src/api.js` | `default` | Pre-configured Axios instance |

This package has no build step. Workspaces consume the source files directly
through the `@shared` alias, so changes here are picked up by Vite's dev server
without a rebuild.

## Importing from a workspace

`@shared` is an alias for `packages/shared/src`, declared in each app's Vite
config:

```js
// apps/admin/vite.config.js (identical in apps/landing)
resolve: {
  alias: {
    '@': path.resolve(__dirname, './src'),
    '@shared': path.resolve(__dirname, '../../packages/shared/src'),
  },
},
```

Because the alias points at the directory rather than a package entry point,
import with a path relative to `src/`:

```jsx
import Loader from '@shared/Loader';
import { formatDate } from '@shared/formatDate';
import { normalizeError } from '@shared/normalizeError.js';
import ErrorBoundary from '@shared/ErrorBoundary.jsx';
import api from '@shared/api';
import { redact } from '@shared/logger.js';
```

> **Note on file extensions.** Both forms appear in the codebase — with
> (`.js`, `.jsx`) and without. Vite resolves either. When adding an import,
> match the surrounding style of the file you are editing rather than
> normalizing existing lines, to keep diffs small.

## Components

### `Loader`

Inline spinner for pending states. Wraps a [lucide-react](https://lucide.dev)
`Loader2` icon with a spin animation.

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `size` | `number` | `24` | Icon size in pixels |
| `className` | `string` | `'text-primary'` | Appended after `animate-spin`, so it must contain only utility classes — passing a conflicting animation or display class will override the spinner |
| `role` | `'status'` | — | Fixed, not configurable |
| `aria-label` | `'Loading'` | — | Fixed, not configurable |

**Accessibility:** renders inside `<span role="status" aria-label="Loading">`,
so screen readers announce the loading state without extra markup.

```jsx
// Default size and colour
if (loading) return <Loader />;

// Compact, muted variant for inline or table-cell use
if (loading) return <Loader size={16} className="text-gray-400" />;
```

### `ErrorBoundary`

Class component that catches render-phase errors in its subtree and renders a
recovery UI instead of a blank screen.

Props:

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `children` | `React.ReactNode` | — | Subtree to protect |
| `variant` | `'admin' \| 'landing'` | `'landing'` | Passed to `ErrorFallback` to switch navigation targets |
| `onError` | `(normalized, errorInfo) => void` | — | Called after a catch, for external reporting or test assertions. Exceptions thrown here are swallowed |
| `fallback` | `({ normalized, onReset }) => React.ReactNode` | — | Render prop that replaces `ErrorFallback` entirely, for route-level isolation |

**Scope.** Catches synchronous render and lifecycle errors within the subtree.
It does **not** catch errors thrown in event handlers, async callbacks, or
outside the React render tree — handle those with `try`/`catch` at the call
site.

**Security.** The raw error is normalized before rendering; only
`normalized.userMessage` reaches the UI. Stack traces, raw messages, and
correlation IDs are logged to the console and never rendered.

```jsx
import ErrorBoundary from '@shared/ErrorBoundary.jsx';

<ErrorBoundary variant="admin" onError={(normalized) => report(normalized)}>
  <Dashboard />
</ErrorBoundary>

// With a custom fallback instead of the default recovery UI:
<ErrorBoundary fallback={({ normalized, onReset }) => (
  <MyRouteError state={normalized} onRetry={onReset} />
)}>
  <Dashboard />
</ErrorBoundary>
```

### `ErrorFallback`

The default recovery UI rendered by `ErrorBoundary`. Accepts static, safe copy
only — it never displays `error.message`, stack traces, component names, file
paths, or raw API responses.

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `variant` | `'admin' \| 'landing'` | `'landing'` | In `admin`, an additional "Sign in again" link is shown |
| `onReset` | `() => void` | — | Required. Wired to the "Try again" button; clears the boundary so React re-renders the subtree |

**Accessibility:** `role="alert"` with `aria-live="assertive"` announces the
failure immediately; the decorative icon is marked `aria-hidden`; all
interactive controls have visible `focus-visible` outlines and descriptive
labels.

## Utilities

### `formatDate(dateString)`

Formats a timestamp for display using `Intl.DateTimeFormat` with the `en-US`
locale, `dateStyle: 'medium'` and `timeStyle: 'short'`.

```js
import { formatDate } from '@shared/formatDate';

formatDate('2026-09-25T13:45:00');  // => "Sep 25, 2026, 1:45 PM"
formatDate('2026-09-25T13:45:00Z'); // => zone-dependent, e.g. "Sep 25, 2026, 9:45 PM" in UTC+8
formatDate(null);                   // => ""
```

Returns an empty string for any falsy input, so it is safe to call directly in
JSX without a guard. Two behaviours are worth knowing when wiring it up:

- The locale is fixed to `en-US` rather than derived from the viewer, and the
  rendered time follows the browser's time zone. A timestamp carrying a `Z` or
  offset suffix is converted, so the same input renders differently depending
  on where the client is located.
- A falsy value short-circuits, but an **unparseable non-empty string throws**:
  `new Date('not-a-date')` yields an `Invalid Date`, and `Intl.DateTimeFormat`
  rejects it with a `RangeError`. If the value can come from an untrusted
  source, validate it first:

```js
const safeFormat = (value) =>
  value && Number.isNaN(new Date(value).getTime()) ? '' : formatDate(value);
```


### `normalizeError(thrown)`

Converts any thrown value into a stable shape that is safe to render. Handles
`Error` instances, strings, plain objects, `null`/`undefined`, Axios errors with
a `response` shape, and malformed payloads.

Returns an object with two clearly separated halves:

| Field | Type | Safe to render? |
| --- | --- | --- |
| `userMessage` | `string` | **Yes** — static, category-based copy |
| `category` | `'network' \| 'auth' \| 'notFound' \| 'server' \| 'unknown'` | Yes |
| `retryable` | `boolean` | Yes — `false` only for `auth` |
| `correlationId` | `string \| null` | Read from the `x-correlation-id` response header (max 128 chars) |
| `internal` | `object` | **No** — diagnostics for logging only |

Classification order:

1. If an HTTP status is present (Axios error), it wins: `401`/`403` → `auth`,
   `404` → `notFound`, `>= 500` → `server`, anything else → `unknown`.
2. Otherwise `ERR_NETWORK`, `ECONNREFUSED`, or the message `Network Error` →
   `network`.
3. Non-`Error` thrown values → `unknown`.
4. Otherwise the message is matched heuristically (`network`/`fetch` →
   `network`; `auth`/`unauthorized`/`forbidden` → `auth`; else `unknown`).

`internal` includes `name`, `message` (one line, no stack), `status`, and
`path` — the path has its query string stripped so API keys in query params are
never logged. Response bodies are deliberately excluded.

```js
import { normalizeError } from '@shared/normalizeError.js';

try {
  await api.get('/admin/users');
} catch (thrown) {
  const { userMessage, retryable, category, internal } = normalizeError(thrown);
  logger.error('Failed to load users', { category, ...internal });
  setError({ userMessage, retryable });  // only safe fields reach the UI
}
```

### `logger` and `redact`

Minimal structured logger with no external SDK dependency. Emits
`{ level, source: 'frontend', timestamp, message, ...context }` to `console`,
matching the contract described in
[`docs/OBSERVABILITY.md`](../../docs/OBSERVABILITY.md).

```js
import { logger } from '@shared/logger.js';

logger.info('User list loaded', { count: 42 });
logger.warn('Unexpected payload shape', { keys: Object.keys(data) });
logger.error('Request failed', { status: 500, correlationId });
```

Every context object is passed through `redact()` first, which recursively
replaces values of sensitive keys with `[REDACTED]`. The redacted key set
(case-insensitive) is: `password`, `token`, `accesstoken`, `refreshtoken`,
`authorization`, `cookie`, `set-cookie`, `x-auth-token`, `privatekey`,
`encryptedkey`, `secret`, `apikey`, `api_key`, `dsn`, `connectionstring`.
Circular references become `'[Circular]'`.

`redact` is also exported on its own for redacting objects before sending them
anywhere else:

```js
import { redact } from '@shared/logger.js';

const safe = redact({ user: 'ada', apiKey: 'sk_live_...' });
// => { user: 'ada', apiKey: '[REDACTED]' }
```

**The redaction list is an allowlist of key names, not a content scanner.**
Secrets placed under an unlisted key (for example `meta.note`) are not caught,
so do not rely on `redact` as a substitute for keeping credentials out of log
calls in the first place.

### `api`

Axios instance shared by both frontends. Attaches no auth headers — apps set
those per request (see [`apps/admin/README.md`](../../apps/admin/README.md) for
the admin token flow).

```js
import api from '@shared/api';

const { data } = await api.get('/admin/stats');
```

Defaults:

- `baseURL`: `import.meta.env.VITE_API_BASE_URL`, falling back to
  `http://localhost:3002/api`
- `headers`: `{ 'Content-Type': 'application/json' }`

Because this file is consumed as source by each Vite app,
`import.meta.env` resolves in the **consuming app's** build. Set
`VITE_API_BASE_URL` in that app's `.env` (for example `apps/admin/.env`), not at
the repository root.

## Security invariants

Two rules in this package exist to keep sensitive data out of the UI. Both are
enforced by the modules themselves, not by convention:

1. `normalizeError` splits user-facing copy from diagnostics. Render
   `userMessage`; log `internal`. Never render `internal`.
2. `logger` redacts a known set of sensitive key names before writing to the
   console.

When extending either module, keep these invariants intact — a new field added
to `userMessage` or to the log record must be reviewed for information leakage.

## Peer dependencies

These are provided by the consuming app, not installed by this package:

| Dependency | Range | Used by |
| --- | --- | --- |
| `react` | `>=18` | `Loader`, `ErrorBoundary`, `ErrorFallback` |
| `axios` | `^1` | `api` |
| `lucide-react` | `*` | `Loader` |

## Related documentation

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — workflow and PR requirements
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — how the workspaces fit together
- [`apps/admin/README.md`](../../apps/admin/README.md) — admin app, auth flow, routes
- [`apps/landing/README.md`](../../apps/landing/README.md) — landing app
- [`docs/OBSERVABILITY.md`](../../docs/OBSERVABILITY.md) — logging and telemetry contract
