# SendAm Admin Dashboard

The SendAm admin dashboard is a Vite + React app for monitoring the platform: it shows aggregate stats and browsable tables of users, wallets, and transactions, backed by the token-protected admin API in `apps/api`.

Part of the [SendAm](../../README.md) monorepo.

## Pages

```text
/login             Admin login screen
/set-password      Private password setup for bootstrap / rotated credentials
/                  Dashboard overview (stats)
/users             User table
/wallets           Wallet table
/transactions      Transaction table
/transactions/:id  Transaction detail (drill-down from the transactions table)
/kyc               KYC review queue
/audit-logs        Audit log browser
/system-health     System health probe
```

`/login` and `/set-password` render outside `AdminLayout`; the other eight routes render inside
`AdminLayout`, which wraps them in `ProtectedRoute` (unauthenticated visitors are redirected to
`/login`) and provides the sidebar, theme toggle, and `⌘K` / `Ctrl+K` global search.

The sidebar only lists destinations the signed-in operator is allowed to reach — `AdminSidebar`
calls `getAdminMe()` and keeps a link only when `hasPermission()` matches:

| Sidebar link | Route | Required permission |
| --- | --- | --- |
| Overview | `/` | `admin.read` |
| Users | `/users` | `admin.read` |
| Wallets | `/wallets` | `admin.read` |
| Transactions | `/transactions` | `admin.read` |
| KYC | `/kyc` | `compliance.read` |
| Audit | `/audit-logs` | `admin.read` |
| Health | `/system-health` | `operations.write` |

If `getAdminMe()` fails the sidebar renders no links at all. `/transactions/:id` has no sidebar
entry — it is reached by clicking a row in the transactions table.

## Operator Workflows

### Login (`/login`) and password rotation (`/set-password`)

1. Submit an email and password. `Login.jsx` posts them to `POST /api/admin/login`.
2. When the API responds with `mustChangePassword: true`, the app navigates to `/set-password`
   instead of the dashboard.
3. `/set-password` asks for the current password, a new password, and a confirmation. The new
   password must be at least 12 characters; on success the operator lands on `/`.
4. Pressing `Logout` in the sidebar clears the stored token and returns to `/login`.

### Dashboard (`/`)

Read-only overview: seven stat cards (total users, managed wallets, all transactions, successful
transactions, failed transactions, pending transactions, pending KYC) followed by a
"Settled Volume by Asset" table listing each asset's amount, its base-currency equivalent, and
the rate source. The `baseCurrency` equivalent renders as `unavailable` when the API omits
`baseAmount`.

### Users (`/users`)

- Filter and page the user table, then drill into **Onboarding Status** to see the blockers that
  keep an account from completing onboarding.
- **Deactivate** opens a dialog that requires a reason (`risk_score_exceeded`,
  `sanctions_match`, `prolonged_inactivity`, `fraud_suspicion`, `customer_request`,
  `regulatory_order`, or `duplicate_account`), free-text operational notes, and an optional
  force flag.
- **Reactivate** captures a resolution rationale (for example "identity verified" or "false
  positive resolved") and an optional second admin ID for the approval record.
- Each row can also download JSON compliance evidence for off-platform review.

### Wallets (`/wallets`)

Browse custodial wallets by user phone, chain, and funding state (`pending`, `funded`, or
`failed`). Columns show the owning user's phone number, the public key, the network, and the
creation date.

### Transactions (`/transactions`) and transaction detail (`/transactions/:id`)

1. Filter the table by status (`pending`, `processing`, `success`, `failed`), asset, rail, user
   phone, user ID, transaction ID or hash, and a from/to date range. Use **Export** to pull the
   current filtered view.
2. Click any row to open `/transactions/:id`, which groups the record into Identifiers, Amount,
   Routing, Parties, Timestamps, and Metadata.
3. From the detail view an operator can **Decode XDR** (opens `XdrDecoderModal`), **Download PDF
   Receipt**, or expand **View Raw JSON** and **Copy JSON** to move the payload into another tool.

### KYC review (`/kyc`)

1. Filter the queue by status (`not_started`, `pending`, `review`, `approved`, `rejected`), phone,
   or country; the table surfaces provider, tier, risk score, and last update.
2. `Approve` and `Reject` are only offered while a row is `pending` or `review`. Both open a
   confirmation dialog first.
3. A rejection requires a reason, and choosing `other` additionally requires explanatory notes —
   the submit button stays disabled until the notes are filled in.
4. Because these are compliance decisions, each mutation is gated behind a WebAuthn passkey
   step-up (`kyc.approve` / `kyc.reject`) before the request is sent.
5. **Export KYC** exports the filtered set either as a plain file or, via the modal, as an
   encrypted `.sendam-enc` bundle protected by an operator-chosen passphrase.

### Audit logs (`/audit-logs`)

1. Narrow entries by action, actor type, actor ID, entity type, entity identifier, and a from/to
   date range.
2. **Export CSV** downloads the audit trail; **Export Workflow Events** downloads the parallel
   workflow-event stream.
3. **Verify Event Chain** runs the tamper-resistance check across the HMAC hash chain and reports
   the number of events verified. Treat a failure here as an incident, not a UI glitch.
4. Pair this screen with the KYC workflow: confirm that an approve/reject decision appears with
   the expected actor and entity before closing a compliance review.

### System health (`/system-health`)

Renders every key/value pair returned by the admin system-health endpoint as a card. There is no
client-side shaping, so the exact fields depend on the API response. A failed probe shows a
sanitized message with a **Try again** button; raw error details are deliberately not rendered.

## How Auth Works

The dashboard authenticates against the backend admin API in `apps/api`:

1. The login screen (`src/pages/Login.jsx`) posts an `{ email, password }` object to `POST /api/admin/login` via `adminLogin` in `src/lib/adminApi.js`. The legacy single-password flow is no longer supported.
2. On success the API returns an HMAC-signed, expiring session token in `data.token`. For bootstrap or temporary credentials the response also includes `mustChangePassword: true`.
3. When `mustChangePassword` is `true`, the app redirects to `/set-password` so the operator sets a private password before any admin work; otherwise it proceeds to the dashboard (`/`).
4. The token is persisted in `localStorage` under the key `adminToken` (see `src/lib/auth.js`) and is attached to every request as `Authorization: Bearer <token>` by a request interceptor in `src/lib/adminApi.js`.
5. Any `401` response clears the stored token and bounces the user back to `/login`.

All data routes (`/stats`, `/users`, `/wallets`, `/transactions`) require a valid token; there is no client-only mock auth.

## Environment Variables

Create `apps/admin/.env`:

```env
VITE_API_BASE_URL=http://localhost:3002/api
```

## Develop

From the repository root:

```bash
npm install
npm run dev:admin     # http://localhost:3001
```

The admin app expects the backend running on `http://localhost:3002` (see `apps/api`).

## Build

```bash
npm run build --workspace=apps/admin
```

## Tech Stack

- Vite + React
- React Router
- Tailwind CSS
- Axios
- Lucide React icons
