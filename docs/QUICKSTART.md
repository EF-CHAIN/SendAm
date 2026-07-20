# Quickstart — local dev in ~10 minutes

Get the SendAm backend running locally and talk to it without WhatsApp.

## Prerequisites

- Node.js 18+ and npm
- A PostgreSQL database — either:
  - a free [Neon](https://neon.tech) database (fastest), or
  - local Postgres (`docker compose up` once the compose file lands — see ISSUES.md)

## 1. Install

```bash
git clone <repo-url> && cd SendAm
npm install
```

## 2. Configure the API

```bash
cp apps/api/.env.example apps/api/.env
```

Minimum required values (the server **fails fast at startup** without them):

```env
DATABASE_URL=postgres://...        # your Neon/local connection string
ENCRYPTION_KEY=<64-char hex>       # openssl rand -hex 32
JWT_SECRET=<32+ chars>             # openssl rand -hex 32
ADMIN_PASSWORD=<anything strong>
```

Everything else can stay blank for local development — external services
(WhatsApp, KYC, Redis, voice) all degrade gracefully when unconfigured.
Leave `ENABLE_WALLET_REST_API` unset: outside production it defaults to
**enabled**, which is what you want locally.

## 3. Database

```bash
npm run prisma:generate --workspace=apps/api
npm run prisma:deploy --workspace=apps/api
```

## 4. Run

```bash
npm run dev:api        # API on http://localhost:3002
```

Health check:

```bash
curl http://localhost:3002/health
# {"status":"ok","db":"connected",...}
```

## 5. Do something real (no WhatsApp needed)

The REST wallet API mirrors the WhatsApp actions (local testing only —
disabled in production):

```bash
# Create a Stellar wallet (auto-funded via testnet Friendbot)
curl -X POST http://localhost:3002/api/wallet/create \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+2348000000001"}'

# Check the balance
curl http://localhost:3002/api/wallet/+2348000000001/balance
```

Create a second wallet and send between them:

```bash
curl -X POST http://localhost:3002/api/wallet/send \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+2348000000001","amount":"5","destination":"<G... key of wallet 2>"}'
```

For the conversational surface without Meta, see
[`CHAT-SIM.md`](CHAT-SIM.md).

## 6. Tests

```bash
npm test               # full suite, from the repo root (node:test, no extra deps)
```

Every PR must ship tests — see CONTRIBUTING.md.

## 7. Frontends (optional)

```bash
npm run dev:landing    # public site
npm run dev:admin      # admin dashboard — needs VITE_API_BASE_URL, see README
```

Admin login uses the `ADMIN_PASSWORD` you set in step 2.

## Where to go next

- [`COMMANDS.md`](COMMANDS.md) — what the bot understands
- [`STELLAR.md`](STELLAR.md) — Stellar concepts this codebase leans on
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — how the backend is put together
- [`../ISSUES.md`](../ISSUES.md) — the backlog, labeled by difficulty
