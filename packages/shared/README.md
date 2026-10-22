# @sendam/shared

Shared UI components, utilities, and the API client used by the SendAm frontend workspaces (`apps/landing` and `apps/admin`).

Part of the [SendAm](../../README.md) monorepo.

## What's in here

| File | Export | Purpose |
| --- | --- | --- |
| `src/Loader.jsx` | `default` | Inline loading spinner |
| `src/ErrorBoundary.jsx` | `default` | React error boundary that renders a safe recovery UI |
| `src/ErrorFallback.jsx` | `default` | Recovery UI shown by `ErrorBoundary` |
| `src/formatDate.js` | `formatDate`, `formatRelativeTime`, `subscribeRelativeTime`, `getNextRelativeTimeUpdateDelay` | Locale-aware date/time formatting and live relative time |
| `src/useRelativeTime.js` | `default` | React hook wrapping the live relative time |
| `src/StellarAddress.jsx` | `default` | Truncated Stellar public key with tooltip and copy button |
| `src/normalizeError.js` | `normalizeError` | Turns any thrown value (HTTP, network, Stellar) into `{ title, message, code }` plus safe metadata |
| `src/logger.js` | `logger`, `redact`, `LOG_BUFFER_SIZE` | Structured console logging with secret redaction and a 100-entry in-memory buffer |
| `src/formatCurrency.js` | `formatCurrency` | Fiat and Stellar asset display amounts |
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

### `StellarAddress`

Renders a Stellar public key as `GABC...WXYZ` (first 4 and last 4 characters)
so 56-character addresses no longer break table layouts. The full address is
the button's `title` tooltip; clicking copies it and swaps the copy icon for a
checkmark for two seconds.

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `address` | `string` | — | Full public key. Renders nothing when empty or not a string; values too short to shorten are shown as is |
| `className` | `string` | `''` | Extra classes appended to the button |

Copying uses `navigator.clipboard.writeText` and falls back to
`document.execCommand('copy')`. If both fail the icon stays unchanged and a
"Copy failed" message is announced. A visually hidden `role="status"` region
announces "Address copied", and the button's `aria-label` carries the full
address for screen readers.

```jsx
import StellarAddress from '@shared/StellarAddress.jsx';

<td><StellarAddress address={wallet.publicKey} /></td>
```

## Utilities

### `formatCurrency(amount, currencyCode)`

Formats a finite number or plain decimal string with `Intl.NumberFormat` in
`en-US`, matching the fixed locale used by `formatDate`. ISO currencies use
their standard minor units: USD, EUR, GBP and NGN have exactly two decimals,
and NGN uses the ₦ symbol. Other alphanumeric Stellar asset codes (1–12
characters, including XLM and USDC) use up to seven decimals, omit trailing
zeroes, and appear after the amount. ISO currency codes take precedence over
custom asset codes with the same name. Codes are trimmed; ISO currency codes
are normalized to uppercase, while other asset codes keep their original case
because Stellar asset codes are case-sensitive.

```js
import { formatCurrency } from '@shared/formatCurrency.js';

formatCurrency(1234.5, 'USD');           // "$1,234.50"
formatCurrency(1234.5, 'NGN');           // "₦1,234.50"
formatCurrency('0.0000001', 'XLM');      // "0.0000001 XLM"
formatCurrency('1.12345675', 'USDC');    // "1.1234568 USDC"
```

This is a display utility, not transaction validation or arithmetic. Extra
fractional digits are rounded by Intl (half away from zero), and negative
amounts are allowed. For exact large balances, pass decimal strings directly
from the API; precision already lost in a JavaScript number cannot be recovered.
This requires Intl support for exact decimal-string formatting and
`Intl.supportedValuesOf` (available in modern browsers and Node 20+). Amounts
that round to zero are displayed without a minus sign.
Invalid amounts or codes throw `TypeError` rather than silently displaying a
zero balance. Strings must use plain decimals (no grouping, currency symbols,
or exponent notation); null, empty strings, booleans, NaN and infinity are rejected.
Transaction limits and backend money rules are unchanged.

The formatter tests run in the existing admin CI suite through the shared alias:
`npm run test:admin -- src/lib/formatCurrency.test.js`.

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

### `formatRelativeTime(date, now?)`

Relative time for live feeds. Accepts a `Date`, ISO string or epoch
milliseconds; `now` (epoch ms) is injectable for tests.

| Age | Output |
| --- | --- |
| under 1 minute | `Just now` |
| under 1 hour | `5m ago` |
| under 24 hours | `2h ago` |
| 24 hours or more | the absolute `formatDate` output |

Timestamps up to a minute in the future (client clock skew) read `Just now`.
Further ahead they are rendered with `Intl.RelativeTimeFormat` (`in 5 minutes`)
for the next 24 hours, then as an absolute date. Unlike `formatDate`, empty or
unparseable input returns `''` instead of throwing. The English suffixes are
fixed so the output is identical in every browser.

To keep the text fresh, `subscribeRelativeTime(date, callback)` calls the
callback immediately and again on every minute boundary while the event is
under an hour old, then hourly until it rolls over to the absolute date, after
which it stops. It returns an unsubscribe function.
`getNextRelativeTimeUpdateDelay(date, now?)` exposes the next delay (or `null`).
In React use the hook, which cleans up on unmount:

```jsx
import useRelativeTime from '@shared/useRelativeTime.js';

function Age({ createdAt }) {
  const text = useRelativeTime(createdAt); // "Just now" -> "1m ago" -> ...
  return <time dateTime={createdAt} title={formatDate(createdAt)}>{text}</time>;
}
```


### `normalizeError(thrown)`

Converts any thrown value into a stable shape that is safe to render. Handles
`Error` instances, strings, plain objects, `null`/`undefined`, Axios errors with
a `response` shape, fetch failures, `{ status }` objects, network disconnects,
timeouts, cancellations, Stellar Horizon result codes, and malformed payloads.
It never throws.

| Field | Type | Safe to render? |
| --- | --- | --- |
| `title` | `string` | **Yes** — short heading for a toast or alert |
| `message` | `string` | **Yes** — actionable, static copy |
| `code` | `string` | Yes — stable identifier, see below |
| `userMessage` | `string` | **Yes** — alias of `message`, kept for existing callers |
| `category` | `'network' \| 'auth' \| 'notFound' \| 'server' \| 'stellar' \| 'unknown'` | Yes |
| `retryable` | `boolean` | Yes — whether a retry can help (`false` for auth, validation, missing resources and permanent Stellar failures) |
| `correlationId` | `string \| null` | Read from the `x-correlation-id` response header (max 128 chars) |
| `internal` | `object` | **No** — diagnostics for logging only |

Messages are always static copy chosen by `code`; server-provided text is never
rendered.

Classification order:

1. Stellar Horizon `extras.result_codes` (on `response.data`, `data` or the
   error itself). The first operation code other than `op_success` wins over
   the transaction code, so `tx_failed` + `op_underfunded` gives
   `op_underfunded`. `code` is the Stellar code (for example `op_underfunded`,
   `tx_bad_seq`, `tx_insufficient_fee`); unknown but well-formed codes get
   generic "Transaction failed" copy and keep their code.
2. An HTTP status from `response.status`, `status` or `statusCode`:
   `BAD_REQUEST`, `AUTH_REQUIRED` (401), `FORBIDDEN`, `NOT_FOUND`, `TIMEOUT`
   (408), `CONFLICT`, `VALIDATION_FAILED` (422), `RATE_LIMITED`, `SERVER_ERROR`,
   `SERVICE_UNAVAILABLE` (502/503), `GATEWAY_TIMEOUT`, `REQUEST_FAILED` for
   other 4xx, and `SERVER_ERROR` for other 5xx.
3. No response: `REQUEST_CANCELED` (`ERR_CANCELED`, `AbortError`), `TIMEOUT`
   (`ECONNABORTED`, `ETIMEDOUT`, `TimeoutError`), `NETWORK_ERROR`
   (`ERR_NETWORK`, `ECONNREFUSED`, `Network Error`, `Failed to fetch`, ...) or
   `OFFLINE` when `navigator.onLine` is `false`.
4. Non-`Error` thrown values -> `UNKNOWN_ERROR`.
5. Otherwise the message is matched heuristically (`network`/`fetch` ->
   `NETWORK_ERROR`; `auth`/`unauthorized`/`forbidden` -> `AUTH_REQUIRED`; else
   `UNKNOWN_ERROR`).

`internal` includes `name`, `message` (one line, no stack), `status`, `path`
(query string stripped so API keys in query params are never logged), the
Stellar code and the API envelope's `error.code` as `backendCode`. Response
bodies and transaction XDR are deliberately excluded.

```js
import { normalizeError } from '@shared/normalizeError.js';

try {
  await submitPayment();
} catch (thrown) {
  const { title, message, code, retryable, internal } = normalizeError(thrown);
  logger.error('Payment failed', { code, ...internal });
  toast.error({ title, message, retryable });  // only safe fields reach the UI
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

Every record is also kept in a circular in-memory buffer holding the last
`LOG_BUFFER_SIZE` (100) entries across all levels, so support can recover what
happened after the console was cleared or the view changed. The buffer lives in
memory only: a full page reload empties it.

```js
logger.getRecentLogs();       // deep copy, oldest first, at most 100 entries
logger.downloadLogs();        // saves sendam-logs-<timestamp>.json, returns the filename
logger.downloadLogs('ticket-42.json');
logger.clearLogs();           // empties the buffer
```

The export is `{ exportedAt, capacity, count, logs }`. Buffered entries are the
already-redacted records, so a download carries no more than the console did.
`downloadLogs` is a no-op returning `null` outside a browser.

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
| `react` | `>=18` | `Loader`, `ErrorBoundary`, `ErrorFallback`, `StellarAddress`, `useRelativeTime` |
| `axios` | `^1` | `api` |
| `lucide-react` | `*` | `Loader`, `StellarAddress` |

## Related documentation

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — workflow and PR requirements
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — how the workspaces fit together
- [`apps/admin/README.md`](../../apps/admin/README.md) — admin app, auth flow, routes
- [`apps/landing/README.md`](../../apps/landing/README.md) — landing app
- [`docs/OBSERVABILITY.md`](../../docs/OBSERVABILITY.md) — logging and telemetry contract
