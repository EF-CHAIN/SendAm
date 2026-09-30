# SendAm Admin Dashboard

The SendAm admin dashboard is a Vite + React app for monitoring the platform: it shows aggregate stats and browsable tables of users, wallets, and transactions, backed by the token-protected admin API in `apps/api`.

Part of the [SendAm](../../README.md) monorepo.

## Pages

```text
/login            Admin login screen
/                 Dashboard overview (stats)
/users            User table
/wallets          Wallet table
/transactions     Transaction table
```

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
