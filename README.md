# SendAm

WhatsApp-first payments with managed wallets, voice-to-cash, escrow, nearby cash-out, and automatic payment-rail routing.

SendAm maps a WhatsApp phone number to a managed wallet and lets users send, receive, escrow, check balances, request receipts, and find cash-out options from chat. The user experience hides blockchain complexity: the backend decides whether a payment should use Lisk, Stellar corridor rails, or a fiat on/off-ramp provider.

> Current status: architecture refactor in progress. The project now has production-oriented module boundaries, queue scaffolding, managed-wallet abstractions, compliance models, and expanded admin surfaces. Live money movement still requires provider credentials, Lisk escrow contracts, KYC/ramp onboarding, monitoring, and compliance review.

## Product Direction

- WhatsApp conversational payment assistant.
- Voice note payment intents with transcription.
- Phone number as managed wallet identity.
- Lisk as the primary settlement layer.
- Stellar only for cross-border payment corridors.
- Yellow Card and Paychant for fiat on/off ramp flows.
- Thirdweb Engine as the preferred Wallet-as-a-Service provider.
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

The backend is being refactored toward:

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

- `wallet`: WalletService abstraction for create/get wallet, send token, balance, and transaction history. App code does not call Thirdweb/Openfort directly.
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

Use `apps/api/.env.example` as the source of truth. The local `apps/api/.env` has been expanded with blank keys for Thirdweb, Lisk, Redis, R2, pricing, KYC, ramps, and voice providers so secrets can be filled in later.

## Local Development

Install dependencies:

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
- Finish Thirdweb Engine/Openfort provider-specific transfer implementation.
- Wire Smile ID or Dojah production KYC callbacks.
- Wire Yellow Card and Paychant quote/execution callbacks.
- Apply the Prisma migration to the Neon database and run provider-level smoke tests.
- Split background workers from the API process in deployment.
- Add automated tests for orchestrator, wallet, webhook, voice, compliance, and escrow flows.
- Add monitoring, alerting, audit review workflows, and admin RBAC.

## License

MIT. See `LICENSE`.
