# @sendam/shared

Shared UI components, utilities, and the API client used by the SendAm frontend workspaces (`apps/landing` and `apps/admin`).

Part of the [SendAm](../../README.md) monorepo.

## What's in here

| File | Export | Purpose |
| --- | --- | --- |
| `src/Loader.jsx` | `default` | Inline loading spinner |
| `src/ToastProvider.jsx` | `default`, `useToast` | Shared toast notification provider with auto-dismiss timers and stacked bottom-right alerts |
| `src/ModalPortal.jsx` | `default` | Accessible modal backdrop portal rendering to `#modal-root` with layout-shift-free scroll lock |
| `src/Tooltip.jsx` | `default` | Floating UI tooltip with collision detection, boundary clamping, and automated flip |
| `src/Skeleton.jsx` | `default` | Shared placeholder skeleton with configurable shimmer and multiple variants |
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

### `ToastProvider` and `useToast`

Unified non-intrusive toast notification system supporting `success`, `error`, `warning`, and `info` toasts with auto-dismiss timers, click-to-dismiss, and smooth exit animations. Toasts stack gracefully in the bottom-right corner of the viewport.

#### Provider Setup

```jsx
import { ToastProvider } from '@shared/ToastProvider.jsx';

function App() {
  return (
    <ToastProvider defaultDuration={4000}>
      <RootRouter />
    </ToastProvider>
  );
}
```

#### Hook Usage

```jsx
import { useToast } from '@shared/ToastProvider.jsx';

function SubmitButton() {
  const { toast } = useToast();

  const handleAction = async () => {
    try {
      await save();
      toast.success('Settings saved successfully');
    } catch (err) {
      toast.error('Failed to save settings');
    }
  };

  return <button onClick={handleAction}>Save</button>;
}
```

| Method / Prop | Signature | Description |
| --- | --- | --- |
| `toast.success(message, options)` | `(string, options?) => string` | Success toast with `role="status"` and `aria-live="polite"` |
| `toast.error(message, options)` | `(string, options?) => string` | Error toast with `role="alert"` and `aria-live="assertive"` |
| `toast.warning(message, options)` | `(string, options?) => string` | Warning toast with `role="status"` |
| `toast.info(message, options)` | `(string, options?) => string` | Info toast with `role="status"` |
| `toast.dismiss(id)` | `(string) => void` | Triggers smooth exit animation and dismisses toast |
| `toast.clear()` | `() => void` | Dismisses all active toasts |

### `ModalPortal`

Accessible backdrop modal rendered using `createPortal` to `#modal-root`. Locks `document.body` scroll while open without layout shift (by offsetting scrollbar width), provides Tab key focus trapping, Escape key listener, and backdrop click dismissal.

```jsx
import ModalPortal from '@shared/ModalPortal.jsx';

function ConfirmDialog({ isOpen, onClose, onConfirm }) {
  return (
    <ModalPortal
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel="Confirm deletion"
      role="alertdialog"
    >
      <div className="bg-white dark:bg-slate-900 rounded-lg p-6 max-w-md shadow-xl border border-gray-200 dark:border-slate-800">
        <h3 className="text-lg font-bold">Are you sure?</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">This action cannot be undone.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose}>Cancel</button>
          <button onClick={onConfirm} className="bg-red-600 text-white px-4 py-2 rounded">Delete</button>
        </div>
      </div>
    </ModalPortal>
  );
}
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `isOpen` | `boolean` | `true` | Controls modal visibility and body scroll lock |
| `onClose` | `() => void` | — | Called on Escape or backdrop click |
| `closeOnEsc` | `boolean` | `true` | Closes modal on Escape key press |
| `closeOnBackdropClick` | `boolean` | `true` | Closes modal when clicking backdrop |
| `role` | `'dialog' \| 'alertdialog'` | `'dialog'` | Accessible dialog role |
| `ariaLabel` / `ariaLabelledBy` | `string` | — | Accessible naming |
| `rootId` | `string` | `'modal-root'` | Portal target element ID (created automatically if missing) |

### `Tooltip`

Lightweight floating tooltip with automated boundary collision detection, screen-edge clamping, and auto-flip positioning. Stays fully visible regardless of scroll position or screen edge proximity, and is accessible via keyboard focus and hover.

```jsx
import Tooltip from '@shared/Tooltip.jsx';

<Tooltip content="Export all settlement records as CSV" placement="top">
  <button type="button">Export</button>
</Tooltip>
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `content` | `React.ReactNode` | — | Tooltip body content |
| `placement` | `'top' \| 'bottom' \| 'left' \| 'right'` | `'top'` | Preferred initial placement; flips automatically on collision |
| `delay` | `number` | `100` | Delay before showing tooltip (ms) |
| `offset` | `number` | `8` | Distance in pixels between trigger and tooltip bubble |
| `padding` | `number` | `8` | Viewport edge padding margin in pixels |
| `disabled` | `boolean` | `false` | Disables tooltip display when true |

### `Skeleton`

Shared skeleton placeholder component with configurable shimmer effect, supporting `text`, `circular`, and `rectangular` variants to replace custom loading placeholders.

```jsx
import Skeleton from '@shared/Skeleton.jsx';

// Text lines
<Skeleton variant="text" count={3} />

// Circular avatar
<Skeleton variant="circular" width={40} height={40} />

// Rectangular card placeholder with shimmer
<Skeleton variant="rectangular" height={160} animation="shimmer" />
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `variant` | `'text' \| 'circular' \| 'rectangular'` | `'rectangular'` | Shape variant |
| `animation` | `'shimmer' \| 'pulse' \| 'none'` | `'shimmer'` | Animation style |
| `width` | `string \| number` | — | Custom width (e.g. `100`, `'100%'`, `'4rem'`) |
| `height` | `string \| number` | — | Custom height (e.g. `20`, `'2.5rem'`) |
| `count` | `number` | `1` | Number of skeleton elements stacked together |

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
