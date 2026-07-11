# SendAm

WhatsApp-first payments with direct-custody wallets, voice-to-cash, escrow, nearby cash-out, and automatic payment-rail routing.

SendAm maps a WhatsApp phone number to a Stellar wallet and a Lisk wallet and lets users send, receive, escrow, check balances, request receipts, and find cash-out options from chat. The user experience hides blockchain complexity: the backend decides whether a payment should use Lisk, Stellar corridor rails, or a fiat on/off-ramp provider, based on the destination address.

> Current status: architecture refactor in progress. The project now has production-oriented module boundaries, queue scaffolding, managed-wallet abstractions, compliance models, and expanded admin surfaces. Live money movement still requires provider credentials, Lisk escrow contracts, KYC/ramp onboarding, monitoring, and compliance review.

## Product Direction

- WhatsApp conversational payment assistant.
- Voice note payment intents with transcription.
- Phone number as wallet identity — every user gets a Stellar and a Lisk wallet.
- Direct custody: keys generated and encrypted (AES-256-GCM) locally, not managed by a third-party provider.
- Lisk as the primary settlement layer.
- Stellar only for cross-border payment corridors.
- Yellow Card and Paychant for fiat on/off ramp flows.
- KYC, PIN verification, audit logs, limits, and risk scoring.
- BullMQ background processing for webhook, voice, receipt, and settlement jobs.

## Monorepo Structure

```text
SendAm/
  apps/
    api/       Express backend and worker-ready modules
    landing/   Vite + React public site
    admin/     Vite + React admin dashboard
  packages/
    shared/    Shared frontend utilities and UI
```

The backend is organized toward:

```text
src/
  auth/
  whatsapp/
  wallet/
  payment/
  escrow/
  compliance/
  voice/
  notifications/
  admin/
  pricing/
  blockchain/
  queues/
  jobs/
  common/
```

## Backend Modules

- `wallet`: Direct-custody chain adapters (Stellar, Lisk) plus a `WalletService` abstraction for create/get wallet, send, balance, and transaction history. App code never imports a chain SDK directly — see `chainRegistry.js`.
- `payment`: Payment Orchestrator for quotes, fees, rail selection, transaction execution, and receipts.
- `blockchain`: Rail selection. Lisk is primary; Stellar is selected for cross-border routes.
- `whatsapp`: Conversational assistant for send money, receive money, balance, escrow, cash-out, contacts, history, and receipts.
- `voice`: WhatsApp audio download and Deepgram transcription pipeline.
- `escrow`: Lisk escrow lifecycle scaffolding for create, release, refund, dispute, and arbiter approval.
- `compliance`: KYC tiers, transaction limits, PIN verification, and risk scoring.
- `pricing`: FX/quote service hooks for ExchangeRate API, CoinGecko, and ramp quotes.
- `queues/jobs`: BullMQ processors for asynchronous webhook and voice processing.
- `admin`: Monitoring endpoints for transactions, KYC, escrows, audit logs, and system health.

## API Summary

```text
POST /api/wallet/create
GET  /api/wallet/:phone/balance
GET  /api/wallet/:phone/transactions
POST /api/wallet/send

POST /api/escrow
GET  /api/escrow
POST /api/escrow/:id/dispute
POST /api/escrow/:id/release
POST /api/escrow/:id/refund

POST /api/pricing/quote

GET  /api/compliance/kyc/:phone
POST /api/compliance/kyc/start
POST /api/compliance/kyc/:id/review
POST /api/compliance/pin

GET  /api/admin/stats
GET  /api/admin/users
GET  /api/admin/wallets
GET  /api/admin/transactions
GET  /api/admin/escrows
GET  /api/admin/kyc
GET  /api/admin/audit-logs
GET  /api/admin/system-health

GET  /webhook
POST /webhook
```

## Infrastructure Target

- Frontend: Vercel
- Backend API: Railway
- Workers: Railway or another long-running worker host, not Vercel
- Database: Neon PostgreSQL with Prisma
- Redis: Upstash
- Storage: Cloudflare R2

## Environment Variables

Use `apps/api/.env.example` as the source of truth. The local `apps/api/.env` has been expanded with blank keys for Lisk, Redis, R2, pricing, KYC, ramps, and voice providers so secrets can be filled in later.

> The REST wallet API (`/api/wallet/*`) is unauthenticated and is disabled in production unless `ENABLE_WALLET_REST_API=true`. Outside production it defaults to enabled for local testing. WhatsApp is the real, signature-verified surface.

## Local Development

For the admin app (`apps/admin/.env`), configure:

```env
VITE_API_BASE_URL=http://localhost:3002/api
```

For the landing app (`apps/landing/.env`), configure:

```env
VITE_ADMIN_URL=http://localhost:3001
```

For production, set `VITE_ADMIN_URL` to the admin dashboard subdomain, for
example `https://admin.your-domain.com`.

## Getting Started

### Prerequisites

- Node.js 18 or newer
- npm
- A PostgreSQL connection string (e.g. Neon) for `DATABASE_URL`
- WhatsApp Business Cloud API credentials for webhook testing

### Install Dependencies

From the repository root:

```bash
npm install
```

Run API:

```bash
npm run prisma:generate --workspace=apps/api
npm run prisma:deploy --workspace=apps/api
npm run dev:api
```

Run frontend apps:

```bash
npm run dev:landing
npm run dev:admin
```

Run builds:

```bash
npm run build:landing
npm run build:admin
```

## Production Readiness Gaps

- Deploy and verify Lisk escrow smart contracts.
- Support non-native assets per chain (Stellar `changeTrust`, Lisk bridged/ERC-20 USDC).
- Wire Smile ID or Dojah production KYC callbacks.
- Wire Yellow Card and Paychant quote/execution callbacks.
- Apply the Prisma migration to the Neon database and run provider-level smoke tests.
- Split background workers from the API process in deployment.
- Add automated tests for orchestrator, wallet, webhook, voice, compliance, and escrow flows.
- Add monitoring, alerting, audit review workflows, and admin RBAC.
- Build real per-user authentication for the compliance PIN and KYC-start endpoints — they're gated off in production by default (`ENABLE_WALLET_REST_API`, same as the wallet REST API) until then, so they have no working production path yet.

### Run The Tests

The backend ships with a unit test suite on the built-in Node test runner (no extra dependencies), covering wallet-secret encryption, admin auth, and request validators:

```bash
npm test                            # from the repo root
npm run test --workspace=apps/api   # equivalently
```

## Deployment

The three apps deploy differently because of how they run:

### Frontend (`landing`, `admin`)

Static Vite builds — deploy to any static host (Vercel, Netlify, Cloudflare Pages). Build command `npm run build --workspace=apps/landing` (or `apps/admin`), output in `apps/<app>/dist`. Set the `VITE_*` variables (see [Environment Variables](#environment-variables)) at build time.

### Backend (`api`)

The API is a **long-running Express server** (`app.listen` in `src/server.js`), so deploy it to a **persistent Node host** — Render, Railway, Fly.io, or a VM — not Vercel/Lambda serverless functions as written. The WhatsApp webhook acknowledges Meta immediately and processes the message asynchronously (via BullMQ), so a serverless function that freezes after responding would drop in-flight work.

Backend deployment checklist:

- Provision a PostgreSQL database (e.g. Neon) and set `DATABASE_URL`.
- Run `npm run prisma:deploy --workspace=apps/api` to apply migrations.
- Set every required `apps/api` variable — the server **fails fast at startup** without `ENCRYPTION_KEY`, `JWT_SECRET`, and `ADMIN_PASSWORD`, and rejects unsigned webhooks in production without `WHATSAPP_APP_SECRET`.
- Set `NODE_ENV=production` and a `CORS_ORIGINS` allowlist covering the deployed admin/landing URLs.
- Point the host's health check at `GET /health` (returns 503 if the database link is down).
- Configure the WhatsApp Business webhook URL to `https://<api-host>/webhook` with a matching `WHATSAPP_VERIFY_TOKEN`.

## Web App Pages

Landing app (`apps/landing`):

```text
/                 Landing page
```

Admin app (`apps/admin`):

```text
/login            Admin login screen
/                 Dashboard overview
/users            User table
/wallets          Wallet table
/transactions     Transaction table
/escrows          Escrow table
/kyc              KYC review
/audit-logs       Audit logs
/system-health    System health
```

## Security Notes

This project is a work-in-progress platform expansion. Some hardening is already in place:

- Real backend admin authentication (HMAC-signed session tokens); the API refuses to start without `ADMIN_PASSWORD` and `JWT_SECRET`.
- Admin API routes protected server-side by the `requireAdmin` middleware.
- Wallet private keys encrypted with authenticated AES-256-GCM (tamper-detecting); the server fails fast at startup without a valid `ENCRYPTION_KEY`.
- WhatsApp webhook POSTs verified against the `X-Hub-Signature-256` header (fail-closed in production).
- Inbound message idempotency to prevent duplicate transfers from webhook retries.
- KYC tiers with daily/single-transaction limits and risk scoring, enforced on every payment via the Payment Orchestrator.
- CORS restricted to a configured origin allowlist in production.
- PostgreSQL-backed rate limiting (shared across instances): per-IP on the REST API and per-sender on the WhatsApp webhook.
- The unauthenticated REST wallet API, plus `POST /api/compliance/pin` and `POST /api/compliance/kyc/start` (which have the same phone-number-only identity model), are all disabled in production by default (`ENABLE_WALLET_REST_API`); WhatsApp is the signature-verified product surface.

Still required before a real-money launch:

- Build real per-user authentication for `POST /api/compliance/pin` and `POST /api/compliance/kyc/start` so they can be enabled in production — right now they're only usable with the flag on, which means no user can self-serve a PIN or start KYC in production at all.
- Add secure, managed secret/key management (KMS/HSM) instead of a single static `ENCRYPTION_KEY` for wallet private keys; support key rotation.
- Add audit-log coverage for all sensitive admin and compliance actions, plus monitoring/alerting.
- Expand the automated test suite to cover the payment orchestrator, wallet, webhook, voice, compliance, and escrow flows.
- Replace the single shared admin password with real admin accounts and roles.
- Complete legal, compliance, KYC, AML, and custody review where required.

## License

MIT. See `LICENSE`.
