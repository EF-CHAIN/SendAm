# SendAm API

Express backend for the new SendAm architecture: WhatsApp conversational payments, direct-custody wallets, payment orchestration, compliance, voice transcription, escrow, pricing, queues, and admin monitoring.

## Architecture

The API is moving away from the original Stellar-only wallet bot. The current backend now routes work through these modules:

```text
src/
  whatsapp/      Conversational assistant
  wallet/        Chain adapters (Stellar, Lisk) + WalletService abstraction
  payment/       Payment Orchestrator
  escrow/        Lisk escrow lifecycle
  compliance/    KYC tiers, PIN, risk, limits
  voice/         Voice note download + transcription
  pricing/       FX and fee quotes
  blockchain/    Rail selection
  queues/        BullMQ queue helpers
  jobs/          Background processors
  common/        Shared audit helpers
```

## Payment Rails

- Lisk is the primary settlement layer.
- Stellar is reserved for cross-border corridors.
- Yellow Card and Paychant are intended for NGN/USDC cash-in and cash-out.
- The destination address decides which chain a plain send uses (Stellar `G...` StrKey vs. Lisk `0x...`); users never choose or see the rail explicitly — the Payment Orchestrator records it internally.

## Wallets

`src/wallet/wallet.service.js` is the only backend surface that should talk to a chain adapter (`stellar.adapter.js`, `lisk.adapter.js`, resolved via `chainRegistry.js`). Direct custody: each adapter generates a keypair, and the private key is encrypted (AES-256-GCM, `services/crypto.service.js`) before being stored — one `Wallet` row per user per chain.

## Queues

WhatsApp webhooks return `200` immediately, then enqueue work through BullMQ when Redis is configured. In local development without Redis, jobs run through an inline fallback.

## Environment

Use `.env.example`. The main provider keys are:

```text
LISK_RPC_URL=
LISK_ESCROW_CONTRACT_ADDRESS=
REDIS_URL=
DEEPGRAM_API_KEY=
SMILE_ID_PARTNER_ID=
SMILE_ID_API_KEY=
YELLOW_CARD_API_KEY=
PAYCHANT_API_KEY=
EXCHANGERATE_API_KEY=
```

## Tech Stack

- Node.js
- Express
- PostgreSQL (Neon) with Prisma
- `@stellar/stellar-sdk`, `ethers` (Lisk)
- WhatsApp Business Cloud API
- BullMQ / Redis
- Axios
- Helmet, CORS, Morgan
- PostgreSQL-backed rate limiting (`express-rate-limit` + a custom shared store)
- `node:test` for the test suite

## Folder Structure

```text
apps/api/
  src/
    config/        Environment and database configuration
    controllers/   Webhook, wallet, and admin request handlers
    whatsapp/      Conversational assistant
    wallet/        Chain adapters (Stellar, Lisk) + WalletService abstraction
    payment/       Payment Orchestrator
    escrow/        Lisk escrow lifecycle
    compliance/    KYC tiers, PIN, risk, limits
    voice/         Voice note download + transcription
    pricing/       FX and fee quotes
    blockchain/    Rail selection
    queues/        BullMQ queue helpers
    jobs/          Background processors
    middlewares/   Error handling, not-found, admin auth, webhook verify,
                   WhatsApp signature verify, Postgres rate-limit store
    routes/        Express route definitions
    services/      WhatsApp, crypto, adminAuth, rateLimit services
    common/        Prisma client, audit helpers, shared record utils
    utils/         Response helpers, logger, validators
    app.js         Express app setup (middleware, routes)
    server.js      Database connection and server start
  prisma/          Prisma schema and migrations
  test/            node:test suites (crypto, admin auth, validators)
```

## Run

## API Routes

All JSON responses use a consistent envelope:

```jsonc
// success
{ "success": true, "message": "…", "data": { /* … */ } }
// error
{ "success": false, "message": "…" }
```

### Health

```text
GET /health      Liveness/readiness probe (503 if the database link is down)
```

### WhatsApp Webhook

```text
GET  /webhook    Verification handshake (echoes hub.challenge)
POST /webhook    Receives messages — X-Hub-Signature-256 verified first
```

### Admin Routes

```text
POST /api/admin/login          Exchange ADMIN_PASSWORD for a session token
GET  /api/admin/stats          (requires Bearer token)
GET  /api/admin/users          (requires Bearer token)
GET  /api/admin/wallets        (requires Bearer token)
GET  /api/admin/transactions   (requires Bearer token)
GET  /api/admin/escrows        (requires Bearer token)
GET  /api/admin/kyc            (requires Bearer token)
GET  /api/admin/audit-logs     (requires Bearer token)
GET  /api/admin/system-health  (requires Bearer token)
```

`POST /api/admin/login` takes `{ "password": "…" }` and returns `{ data: { token } }`. Send that token as `Authorization: Bearer <token>` on the other admin routes. The login endpoint is rate-limited (10 attempts / 15 min) on top of the global limiter.

The list endpoints (`/users`, `/wallets`, `/transactions`) are paginated via `?page` (default 1) and `?limit` (default 50, max 100). `data` is the array of items; a `pagination` block (`{ page, limit, total, totalPages }`) is returned alongside.

### Wallet Routes (optional, for testing without WhatsApp)

```text
POST /api/wallet/create        { phoneNumber }
GET  /api/wallet/:phone/balance
POST /api/wallet/send          { phoneNumber, amount, destination }
```

> ⚠️ These routes are **unauthenticated** — the phone number in the request body is the only identity. They are intended for local testing of the same wallet actions used by WhatsApp. They are **disabled in production by default**; set `ENABLE_WALLET_REST_API=true` to expose them (not recommended without adding per-user auth first). WhatsApp is the real, signature-verified product surface.

### Compliance Self-Service Routes (optional, for testing without WhatsApp)

```text
POST /api/compliance/kyc/start   { phoneNumber, providerReference }
POST /api/compliance/pin         { phoneNumber, pin }
```

> ⚠️ Same story as the wallet routes above — no per-user identity check, gated behind the same `ENABLE_WALLET_REST_API` flag (`middlewares/requireRestApiEnabled`), and disabled in production by default. `GET /api/compliance/kyc/:phone` and `POST /api/compliance/kyc/:id/review` are different: those require an admin Bearer token and are always on.

## Environment Variables

Create an `.env` file in `apps/api` using `.env.example` as a guide. The app **fails fast at startup** if the required secrets are missing or weak.

```env
PORT=3002
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/sendam

# REST API CORS allowlist (comma-separated). Required in production.
CORS_ORIGINS=http://localhost:3000,http://localhost:3001

# Required. 64-char hex (32 bytes) for AES-256-GCM wallet-secret encryption.
# Generate: openssl rand -hex 32
ENCRYPTION_KEY=

# Required. Admin dashboard auth. ADMIN_PASSWORD is the login password;
# JWT_SECRET (>= 32 chars) signs HMAC session tokens.
ADMIN_PASSWORD=
JWT_SECRET=
ADMIN_SESSION_TTL_HOURS=12

# WhatsApp Business Cloud API
WHATSAPP_TOKEN=your_whatsapp_token_here
WHATSAPP_PHONE_NUMBER_ID=your_phone_id_here
WHATSAPP_VERIFY_TOKEN=your_verify_token
# Required in production. Verifies the X-Hub-Signature-256 header.
WHATSAPP_APP_SECRET=

# Per-user transfer guardrails (XLM)
MAX_SEND_AMOUNT=1000
DAILY_SEND_LIMIT=5000
MAX_SENDS_PER_DAY=50

# Rate limiting (Mongo-backed, shared across instances)
RATE_LIMIT_WINDOW_MIN=15
RATE_LIMIT_MAX=100
BOT_RATE_WINDOW_SEC=60
BOT_RATE_MAX=20

# Stellar
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# Optional: expose the unauthenticated REST wallet API (off in prod by default)
ENABLE_WALLET_REST_API=false
```

`ENCRYPTION_KEY` must be a 64-character hexadecimal string because the app uses **AES-256-GCM** (authenticated encryption) for Stellar secret keys. Generate one with:

```bash
openssl rand -hex 32
# or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Running Locally

From the repository root:

```bash
npm install
npm run prisma:generate --workspace=apps/api
npm run prisma:deploy --workspace=apps/api
npm run dev --workspace=apps/api
```

For local schema changes during development:

```bash
npm run prisma:migrate --workspace=apps/api
```

## Important Gaps

This refactor adds production module boundaries, Prisma/PostgreSQL persistence, and provider adapters, but real-money launch still needs final provider onboarding, contract deployment, worker deployment, automated tests, monitoring, admin RBAC, and compliance approval — including real per-user authentication for the compliance PIN and KYC-start endpoints, which are gated off in production for now (see below).

The backend runs on `http://localhost:3002`.

## Testing

Unit tests (crypto, admin auth, validators) run on the built-in Node test runner — no extra dependencies:

```bash
npm test                         # from apps/api
npm run test --workspace=apps/api  # from the repo root
```

Quick syntax check on a file you changed:

```bash
node --check src/app.js
```

## Testing The REST API

> Requires `ENABLE_WALLET_REST_API=true` (default outside production).

Create a wallet:

```bash
curl -X POST http://localhost:3002/api/wallet/create \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+2348000000000"}'
```

Check balance:

```bash
curl http://localhost:3002/api/wallet/+2348000000000/balance
```

Send a payment:

```bash
curl -X POST http://localhost:3002/api/wallet/send \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+2348000000000","amount":"5","destination":"0xDESTINATIONADDRESS"}'
```

## Testing WhatsApp Webhooks Locally

1. Start the backend on port `3002`.
2. Expose the backend with `ngrok` or `localtunnel`.
3. Configure the WhatsApp Business webhook URL as `https://your-public-url/webhook`.
4. Set the same verify token in WhatsApp and `WHATSAPP_VERIFY_TOKEN`.
5. Set `WHATSAPP_APP_SECRET` to your Meta app secret so POST signatures verify (in development, an unset secret is allowed with a warning; in production unsigned POSTs are rejected).
6. Send a WhatsApp message to the configured business number.

## Security Posture

Already in place:

- Real admin authentication with HMAC-signed, expiring session tokens; the API refuses to start without `ADMIN_PASSWORD` and `JWT_SECRET`.
- Admin API routes protected by the `requireAdmin` middleware; login endpoint rate-limited.
- WhatsApp webhook POSTs verified against `X-Hub-Signature-256` (fail-closed in production).
- Inbound message idempotency to prevent duplicate transfers from webhook retries.
- KYC tiers with daily/single-transaction limits and risk scoring, enforced on every payment via the Payment Orchestrator.
- CORS allowlist enforced in production; PostgreSQL-backed shared rate limiting.
- The unauthenticated REST wallet API, and the equally unauthenticated `POST /api/compliance/pin` / `POST /api/compliance/kyc/start`, are all disabled in production by default (`ENABLE_WALLET_REST_API`).

## Security and Production Requirements

Before a real-money launch, this backend still needs:

- Real per-user authentication for `POST /api/compliance/pin` and `POST /api/compliance/kyc/start` — they currently accept any phone number with no identity check, so they're kept behind the production flag rather than actually fixed; no user can self-serve a PIN or start KYC in production until this is built.
- Managed secret/key management (KMS/HSM) for provider credentials, with key rotation.
- Audit-log coverage for all sensitive admin and compliance actions, plus monitoring and alerting.
- Replacement of the single shared admin password with real admin accounts and roles.
- Broader automated test coverage (payment orchestrator, wallet, webhook, voice, compliance, and escrow flows).
- Legal, compliance, KYC, AML, and custody review where required.

## Current Limitations

- Simple WhatsApp command/intent parsing (regex-based).
- Single shared admin password (no per-admin accounts or roles yet).
- REST wallet API, compliance PIN, and KYC-start endpoints are unauthenticated by design and disabled in production by default (see above) — no working production path until real per-user auth exists.
- No customer web login/signup — WhatsApp phone number is the identity.
- Stellar corridor and fiat ramp execution are stubbed pending provider/custody onboarding.
