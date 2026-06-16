# SendAm

WhatsApp-first payments powered by the Stellar network.

SendAm is a financial access MVP that lets people create a Stellar wallet, check their XLM balance, and send XLM using simple WhatsApp messages. The goal is to make blockchain payments feel as familiar as sending a chat message, especially for users who may not be comfortable with browser wallets, seed phrases, or exchange-style interfaces.

## Live Links

- Web app: https://send-am-web.vercel.app/
- API: https://send-am-api.vercel.app/
- Repository: https://github.com/Gozirimdev/SendAm

> Current status: MVP running on Stellar Testnet. This repository is not yet configured for real-money production use.

## Why SendAm

Many people already understand WhatsApp, but crypto wallets still feel technical, intimidating, and risky. SendAm bridges that gap by turning WhatsApp into a simple payment interface while using Stellar for fast, low-cost settlement.

The product is designed for users who need:

- A familiar way to interact with digital money.
- Low-cost cross-border value transfer.
- Wallet creation without installing a separate crypto app.
- A lightweight payment experience that works well on mobile.
- An admin dashboard for monitoring users, wallets, and transactions.

## Why Stellar

Stellar is a strong fit for SendAm because the product needs fast settlement, low fees, simple account primitives, and a network designed for payments. In the MVP, Stellar Testnet is used to:

- Generate Stellar keypairs for new users.
- Fund test wallets through Friendbot.
- Read native XLM balances through Horizon.
- Submit XLM payment transactions.
- Store transaction hashes for auditability and admin review.

The current implementation focuses on native XLM transfers first. The architecture can later support Stellar assets, anchors, fiat on/off ramps, and compliance-aware payment flows.

## Product Overview

SendAm has three main surfaces:

1. WhatsApp bot experience
   Users send natural commands to the bot, such as:

   ```text
   create wallet
   balance
   save ada GABC...
   contacts
   send 5 xlm ada
   send 5 xlm GABC...
   yes
   no
   help
   ```

2. REST API
   The backend exposes wallet and transaction endpoints so the product can be tested without WhatsApp.

3. Web admin dashboard
   Admins can view platform stats, users, wallets, and transaction records.

## Core Features

### User Features

- Create a Stellar Testnet wallet from a WhatsApp command.
- Automatically fund new test wallets using Stellar Friendbot.
- Check XLM balance by sending `balance`.
- Send XLM to another Stellar public address.
- Confirm transfers before funds are submitted to Stellar.
- Save contacts with aliases for repeat payments.
- Receive Stellar Expert receipt links after successful transfers.
- Receive simple WhatsApp replies for successful and failed actions.

### Admin Features

- View total users.
- View total wallets.
- View transaction counts.
- View successful and failed transactions.
- Browse user, wallet, and transaction tables.

### Developer Features

- REST endpoints for wallet creation, balance checks, and XLM transfers.
- MongoDB persistence for users, wallets, and transactions.
- Encrypted storage for Stellar secret keys.
- Separate backend and frontend apps in one monorepo.

## Architecture

```text
WhatsApp User
     |
     v
WhatsApp Business API
     |
     v
Express Webhook API
     |
     +--> Command Parser
     +--> MongoDB: users, wallets, transactions
     +--> Stellar Horizon: balances and payments
     |
     v
WhatsApp Response Message

Admin / Tester
     |
     v
Vite React Apps (landing + admin)
     |
     v
Express REST API
```

## Monorepo Structure

```text
SendAm/
  apps/
    api/       Express backend for WhatsApp, Stellar, MongoDB, and admin APIs
    landing/   Vite + React marketing/landing site
    admin/     Vite + React admin dashboard
  packages/
    shared/    Shared UI (Loader) and utilities (api client, formatDate)
  package.json Root workspace scripts
```

## Tech Stack

### Backend

- Node.js
- Express
- MongoDB with Mongoose
- Stellar SDK
- WhatsApp Business Cloud API
- Axios
- Helmet, CORS, Morgan, and rate limiting

### Frontend

- Vite + React (two apps: landing and admin)
- React Router
- Tailwind CSS
- Axios
- Lucide React icons

### Blockchain

- Stellar Testnet
- Horizon API
- Native XLM payments
- Friendbot funding for test accounts

## How The Main Flow Works

### Wallet Creation

1. User sends `create wallet` on WhatsApp.
2. SendAm creates or finds the user by phone number.
3. Backend generates a Stellar keypair.
4. Secret key is encrypted before storage.
5. Public key is stored on the wallet record.
6. Testnet wallet is funded with Friendbot.
7. User receives their public key by WhatsApp.

### Balance Check

1. User sends `balance`.
2. Backend finds the user's wallet.
3. Backend loads the account from Stellar Horizon.
4. User receives current native XLM balance.

### XLM Transfer

1. User sends a command like `send 5 xlm GABC...` or `send 5 xlm ada`.
2. Backend parses amount and destination, or resolves a saved contact alias.
3. Backend sends a confirmation prompt to the user.
4. User replies `YES` to approve or `NO` to cancel.
5. Backend decrypts the user's stored Stellar secret key.
6. Backend builds, signs, and submits a Stellar payment transaction.
7. Transaction result and Stellar Expert receipt link are saved in MongoDB.
8. User receives success or failure feedback on WhatsApp.

## API Summary

### Wallet API

Base path:

```text
/api/wallet
```

Endpoints:

```text
POST /api/wallet/create
GET  /api/wallet/:phone/balance
POST /api/wallet/send
```

### Admin API

Base path:

```text
/api/admin
```

Endpoints:

```text
GET /api/admin/stats
GET /api/admin/users
GET /api/admin/wallets
GET /api/admin/transactions
```

### WhatsApp Webhook

Base path:

```text
/webhook
```

Endpoints:

```text
GET  /webhook
POST /webhook
```

## Environment Variables

Create an `.env` file inside `apps/api` using `apps/api/.env.example` as a guide.

```env
PORT=3002
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/sendam
CORS_ORIGINS=http://localhost:3000,http://localhost:3001
ENCRYPTION_KEY=your_64_character_hex_key
ADMIN_PASSWORD=your_admin_password
JWT_SECRET=your_64_character_hex_secret
WHATSAPP_TOKEN=your_whatsapp_token_here
WHATSAPP_PHONE_NUMBER_ID=your_phone_id_here
WHATSAPP_VERIFY_TOKEN=your_verify_token
WHATSAPP_APP_SECRET=your_meta_app_secret
MAX_SEND_AMOUNT=1000
DAILY_SEND_LIMIT=5000
MAX_SENDS_PER_DAY=50
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
```

For the admin app (`apps/admin/.env`), configure:

```env
VITE_API_BASE_URL=http://localhost:3002/api
```

For the landing app (`apps/landing/.env`), configure:

```env
VITE_ADMIN_URL=http://localhost:3001
```

## Getting Started

### Prerequisites

- Node.js 18 or newer
- npm
- MongoDB running locally or a MongoDB connection URI
- WhatsApp Business Cloud API credentials for webhook testing

### Install Dependencies

From the repository root:

```bash
npm install
```

### Run The Backend

```bash
npm run dev:api
```

The API runs on:

```text
http://localhost:3002
```

### Run The Frontend

```bash
npm run dev:landing
npm run dev:admin
```

The landing app runs on `http://localhost:3000` and the admin app on
`http://localhost:3001`.

### Run All Apps

```bash
npm run dev
```

This starts the API, landing, and admin apps together.

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
```

## Security Notes

This project is still an MVP. Some hardening is already in place:

- Real backend admin authentication (HMAC-signed session tokens); the API refuses to start without `ADMIN_PASSWORD` and `JWT_SECRET`.
- Admin API routes protected server-side by the `requireAdmin` middleware.
- No fallback encryption key — a missing/invalid `ENCRYPTION_KEY` fails loudly at startup.
- Wallet secrets encrypted with authenticated AES-256-GCM (tamper-detecting).
- Stellar public keys, amounts, and phone numbers validated on every surface.
- WhatsApp webhook POSTs verified against the `X-Hub-Signature-256` header (fail-closed in production).
- Inbound message idempotency to prevent duplicate transfers from webhook retries.
- Per-user transfer guardrails: per-transaction cap plus rolling 24h amount and count limits.
- CORS restricted to a configured origin allowlist in production.
- Mongo-backed rate limiting (shared across instances): per-IP on the REST API and per-sender on the WhatsApp webhook.

Still required before a real-money launch:

- Move from Stellar Testnet to mainnet with a vetted deployment.
- Add secure, managed secret/key management (KMS/HSM) instead of a single static env key; support key rotation.
- Add audit logs for sensitive actions and monitoring/alerting.
- Add an automated test suite (parser, wallet, webhook, transaction flows).
- Replace the single shared admin password with real admin accounts and roles.
- Complete legal, compliance, KYC, AML, and custody review where required.

## Current Limitations

- Uses Stellar Testnet only.
- Supports native XLM transfers only.
- WhatsApp command parser is intentionally simple.
- Single shared admin password (no per-admin accounts or roles yet).
- No customer web signup is required yet because WhatsApp phone number is the MVP identity.
- No production compliance workflow is included yet.

## Roadmap

### MVP Completion

- ~~Real admin authentication.~~ (done)
- ~~Stronger validation for wallet and payment requests.~~ (done)
- ~~Webhook signature verification and transfer guardrails.~~ (done)
- Better WhatsApp command handling, confirmation prompts, and error messages.
- Automated tests for parser, wallet, webhook, and transaction flows.
- Deployment configuration for backend, frontend, database, and environment variables.

### Stellar Product Expansion

- Support custom Stellar assets.
- Expand contact aliases into richer recipient management.
- Add richer transaction receipts with Stellar explorer links.
- Add QR-code public key sharing.
- Add low-balance warnings and safer confirmation flows.
- Explore anchor integrations for fiat on/off ramps.

### Production Readiness

- Compliance review.
- Monitoring and alerting.
- Admin roles and permissions.
- Recovery and support workflows.
- Rate limits per user and per phone number.
- Secure key-management strategy.

## Reviewer's Summary

SendAm demonstrates a practical Stellar use case: making blockchain payments accessible through a communication channel people already use every day. The MVP combines WhatsApp, Stellar Testnet, MongoDB, and a Next.js admin dashboard to show the foundation for a chat-based payment product.

The project is intentionally scoped: it proves wallet creation, balance checks, saved recipients, confirmation-based XLM transfers, and auditable Stellar receipts first. With stronger authentication, validation, compliance work, and production deployment, SendAm can evolve from a Testnet MVP into a broader payments product for mobile-first users.

## License

SendAm is open source and released under the MIT License. See `LICENSE` for details.

## Contributing

Contributions are welcome. See `CONTRIBUTING.md` for setup instructions, contribution areas, pull request guidelines, and security notes.
