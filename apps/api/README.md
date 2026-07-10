# SendAm API

Express backend for the new SendAm architecture: WhatsApp conversational payments, managed wallets, payment orchestration, compliance, voice transcription, escrow, pricing, queues, and admin monitoring.

## Architecture

The API is moving away from the original Stellar-only wallet bot. The current backend now routes work through these modules:

```text
src/
  whatsapp/      Conversational assistant
  wallet/        WalletService abstraction over Thirdweb/Openfort
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
- Users never choose or see the rail; the Payment Orchestrator records it internally.

## Wallets

`src/wallet/wallet.service.js` is the only backend surface that should talk to a WaaS provider. Thirdweb Engine is the preferred provider. Openfort is scaffolded as a swappable adapter.

## Queues

WhatsApp webhooks return `200` immediately, then enqueue work through BullMQ when Redis is configured. In local development without Redis, jobs run through an inline fallback.

## Environment

Use `.env.example`. The main provider keys are:

```text
THIRDWEB_ENGINE_URL=
THIRDWEB_ACCESS_TOKEN=
THIRDWEB_BACKEND_WALLET_ADDRESS=
THIRDWEB_USDC_CONTRACT_ADDRESS=
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

## Run

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

This refactor adds production module boundaries, Prisma/PostgreSQL persistence, and provider adapters, but real-money launch still needs final provider onboarding, contract deployment, worker deployment, automated tests, monitoring, admin RBAC, and compliance approval.
