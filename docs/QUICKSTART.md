# Quickstart — local dev in ~10 minutes

Get the SendAm backend running locally without WhatsApp.

## Prerequisites

- Node.js 20.19+ (or 22.12+ / 24+) and npm — Prisma 7 requires it
- A PostgreSQL database — either:
  - a free [Neon](https://neon.tech) database (fastest), or a free
    [Supabase](https://supabase.com) project — use its **Session pooler**
    connection string (port 5432); the direct connection is IPv6-only on the
    free plan.

## 1. Install

```bash
git clone <repo-url> && cd SendAm
npm install
```

## 2. Configure the API

```bash
cp apps/api/.env.example apps/api/.env
```

Set these in `apps/api/.env` (the server **fails fast at startup** without
them):

```env
DATABASE_URL=postgresql://...      # your Neon or Supabase connection string
ENCRYPTION_KEY=<64-char hex>       # openssl rand -hex 32
JWT_SECRET=<32+ chars>             # openssl rand -hex 32
```

If your database password has special characters, URL-encode them in
`DATABASE_URL` (for example `@` becomes `%40`).

Then change `ENABLE_CHAT_SIM=false` to `ENABLE_CHAT_SIM=` (empty). Empty means
"default", which is on outside production, and the tests in step 6 expect it.

Everything else can stay as it is in the example file: WhatsApp and Redis
settings are only enforced in production, so the API starts without them
locally.

`ENABLE_WALLET_REST_API` ships as `false`, which keeps the wallet REST API
off. Enabling it also needs `STELLAR_AUTH_SIGNING_KEY`, and every request
needs a SEP-10 session — see [`STELLAR.md`](STELLAR.md).

## 3. Database

```bash
npm run prisma:generate --workspace=apps/api
npm run prisma:deploy --workspace=apps/api
```

## 4. Run

```bash
npm run dev:api        # API on http://localhost:3002
```

Health check (from a second terminal):

```bash
curl http://localhost:3002/health/live
# {"status":"ok","uptime":...}
```

`/health` (readiness) also checks Redis and returns 503 "degraded" until
`REDIS_URL` is set. That is expected locally.

## 5. Explore without WhatsApp

- The chat simulator's interface is described in [`CHAT-SIM.md`](CHAT-SIM.md).
- The REST wallet API is off by default and needs a SEP-10 session; see
  [`STELLAR.md`](STELLAR.md).

## 6. Tests

```bash
npm test               # API test suite, from the repo root (node:test, no extra deps)
```

The tests read `apps/api/.env`, so keep `ENABLE_CHAT_SIM` empty as set in
step 2. Landing page tests: `npm run test:landing`.

Every PR must ship tests — see CONTRIBUTING.md.

## 7. Frontends (optional)

```bash
cp apps/admin/.env.example apps/admin/.env   # sets VITE_API_BASE_URL
npm run dev:landing    # public site
npm run dev:admin      # admin dashboard
```

To log in to the admin dashboard, set `ADMIN_PASSWORD` in `apps/api/.env`
first; the first login for `ADMIN_BOOTSTRAP_EMAIL` (`admin@example.com` in the
example file) provisions the administrator.

## Where to go next

- [`COMMANDS.md`](COMMANDS.md) — what the bot understands
- [`STELLAR.md`](STELLAR.md) — Stellar concepts this codebase leans on
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — how the backend is put together
- [`../ISSUES.md`](../ISSUES.md) — the backlog, labeled by difficulty
