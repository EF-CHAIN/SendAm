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

The dashboard authenticates against the backend admin API:

1. The login screen posts the admin password to `POST /api/admin/login`.
2. The API returns an HMAC-signed, expiring session token.
3. The app stores the token and sends it as `Authorization: Bearer <token>` on every admin request.

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
