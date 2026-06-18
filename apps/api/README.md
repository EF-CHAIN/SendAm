# SendAm Backend API

The SendAm backend is the payment engine behind the WhatsApp-first Stellar wallet MVP. It receives WhatsApp webhook events, parses user commands, creates Stellar Testnet wallets, checks balances, sends XLM, stores transaction records, and exposes admin data for the web dashboard.

> Current status: Testnet MVP. The core security hardening (admin auth, webhook signature verification, authenticated encryption, input validation, transfer guardrails) is in place. Real-money production still needs mainnet migration, managed key management, audit logging, and compliance review — see [Security and Production Requirements](#security-and-production-requirements).

## What This API Does

- Receives WhatsApp Business webhook messages (signature-verified).
- Converts simple text commands into wallet actions.
- Creates Stellar keypairs for new users.
- Encrypts and stores Stellar secret keys with authenticated AES-256-GCM.
- Funds new Testnet wallets using Stellar Friendbot, with retry and a `fund` recovery command.
- Checks native XLM balances through Stellar Horizon.
- Saves recipient aliases for repeat payments.
- Requires WhatsApp confirmation before submitting a transfer, and checks balance up front.
- Enforces per-user transfer guardrails (per-transaction cap + rolling 24h amount/count limits).
- Builds, signs, and submits XLM payment transactions.
- Returns Stellar Expert receipt links after successful transfers.
- Stores users, wallets, and transactions in MongoDB.
- Provides admin endpoints (token-protected) for dashboard statistics and tables.
- Optionally exposes REST wallet endpoints for testing without WhatsApp.

## Why It Matters

SendAm is built around a simple idea: people should be able to access blockchain payments without first learning complicated wallet software. This backend makes Stellar usable through WhatsApp, a channel many mobile-first users already understand.

Stellar is used because it provides:

- Fast payment settlement.
- Very low transaction costs.
- Simple account and payment primitives.
- A reliable Horizon API for balances and transaction submission.
- A clear path toward future asset, anchor, and fiat payment integrations.

## Core User Commands

The WhatsApp command parser currently supports:

```text
hi / hello              Greeting
help                    List available commands
create wallet           Create (and fund) a Stellar Testnet wallet
fund / fund wallet      Retry funding if a wallet was created but not funded
balance                 Check your XLM balance
save ada GABC...        Save a contact alias
contacts                List saved contacts
send 5 xlm ada          Prepare a transfer to a saved alias
send 5 xlm GABC...      Prepare a transfer to a public key
yes / confirm           Confirm a pending transfer
no / cancel             Cancel a pending transfer
```

## Main Flow

### Wallet Creation

1. User sends `create wallet` on WhatsApp.
2. Backend creates or finds the user by phone number.
3. Backend generates a Stellar keypair.
4. Secret key is encrypted (AES-256-GCM) before storage.
5. Wallet public key is stored in MongoDB.
6. Testnet wallet is funded through Friendbot (retried on failure).
7. Wallet is marked `funded` and the user receives their public key by WhatsApp.

If Friendbot funding fails, the wallet is left unfunded and the user is told to reply `fund` to retry. Re-sending `create wallet` also re-attempts funding rather than reporting "you already have a wallet".

### Balance Check

1. User sends `balance`.
2. Backend finds the wallet connected to the user's phone number.
3. Backend loads the Stellar account from Horizon.
4. User receives their XLM balance.

### XLM Transfer

1. User sends `send <amount> xlm <destination>` or `send <amount> xlm <saved-name>`.
2. Backend parses the amount and resolves the destination public key.
3. Backend checks the sender's balance and rejects the transfer up front if it is insufficient.
4. Backend sends a confirmation prompt (expires after 10 minutes).
5. User replies `YES` to send or `NO` to cancel.
6. Backend enforces per-user transfer guardrails.
7. Backend decrypts the stored Stellar secret key.
8. Backend builds, signs, and submits a Stellar payment transaction.
9. Transaction status, hash, and Stellar Expert receipt link are stored in MongoDB (both success and failure).
10. User receives a WhatsApp success or failure message.

## Tech Stack

- Node.js
- Express
- MongoDB with Mongoose
- `@stellar/stellar-sdk`
- WhatsApp Business Cloud API
- Axios
- Helmet, CORS, Morgan
- Mongo-backed rate limiting (`express-rate-limit` + a custom shared store)
- `node:test` for the test suite

## Folder Structure

```text
apps/api/
  src/
    config/        Environment, database, and Stellar configuration
    controllers/   Webhook, wallet, and admin request handlers
    middlewares/   Error handling, not-found, admin auth, webhook verify,
                   WhatsApp signature verify, Mongo rate-limit store
    models/        Mongoose models: User, Wallet, Transaction,
                   ProcessedMessage (idempotency), RateLimitHit
    routes/        Express route definitions
    services/      WhatsApp, Stellar, wallet, transaction, crypto,
                   adminAuth, rateLimit services
      agent/       WhatsApp agent: intent parser, handler, replies
    utils/         Response helpers, logger, validators
    app.js         Express app setup (middleware, routes)
    server.js      Database connection and server start
  test/            node:test suites (parser, crypto, admin auth)
```

## API Routes

All JSON responses use a consistent envelope:

```jsonc
// success
{ "success": true, "message": "…", "data": { /* … */ } }
// error
{ "success": false, "message": "…" }
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
```

`POST /api/admin/login` takes `{ "password": "…" }` and returns `{ data: { token } }`. Send that token as `Authorization: Bearer <token>` on the other admin routes. The login endpoint is rate-limited (10 attempts / 15 min) on top of the global limiter.

### Wallet Routes (optional, for testing without WhatsApp)

```text
POST /api/wallet/create        { phoneNumber }
GET  /api/wallet/:phone/balance
POST /api/wallet/send          { phoneNumber, amount, destination }
```

> ⚠️ These routes are **unauthenticated** — the phone number in the request body is the only identity. They are intended for local testing of the same wallet actions used by WhatsApp. They are **disabled in production by default**; set `ENABLE_WALLET_REST_API=true` to expose them (not recommended without adding per-user auth first). WhatsApp is the real, signature-verified product surface.

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
npm run dev:api
```

Or from `apps/api`:

```bash
npm install
npm run dev
```

The backend runs on `http://localhost:3002`.

## Testing

Unit tests (parser, crypto, admin auth) run on the built-in Node test runner — no extra dependencies:

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

Send XLM:

```bash
curl -X POST http://localhost:3002/api/wallet/send \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+2348000000000","amount":"5","destination":"GDESTINATIONPUBLICKEY"}'
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
- Authenticated AES-256-GCM encryption of wallet secrets (tamper-detecting); no fallback key.
- WhatsApp webhook POSTs verified against `X-Hub-Signature-256` (fail-closed in production).
- Inbound message idempotency to prevent duplicate transfers from webhook retries.
- Strong validation of Stellar public keys, amounts, and phone numbers.
- Per-user transfer guardrails plus a pre-confirmation balance check.
- CORS allowlist enforced in production; Mongo-backed shared rate limiting.

## Security and Production Requirements

Before a real-money launch, this backend still needs:

- Migration from Stellar Testnet to mainnet with a vetted deployment.
- Managed secret/key management (KMS/HSM) with key rotation, instead of one static env key.
- Per-user authentication on the REST wallet API (or keep it disabled).
- Audit logs for sensitive actions, plus monitoring and alerting.
- Replacement of the single shared admin password with real admin accounts and roles.
- Broader automated test coverage (webhook and transaction integration flows).
- Legal, compliance, KYC, AML, and custody review where required.

## Current Limitations

- Stellar Testnet only.
- Native XLM transfers only.
- Simple command parser.
- Single shared admin password (no per-admin accounts or roles yet).
- REST wallet API is unauthenticated (and disabled in production by default).
- No customer web login/signup — WhatsApp phone number is the MVP identity.
- No production compliance workflow yet.

## Reviewer Summary

This backend proves the most important SendAm concept: a user can interact with Stellar payments through WhatsApp. It demonstrates wallet creation with funding recovery, balance lookup, saved recipients, confirmation- and limit-guarded XLM transfers, transaction receipts, transaction storage, and token-protected admin observability.

The next major step toward real users is mainnet migration, managed key management, audit logging, broader test coverage, and compliance review.
