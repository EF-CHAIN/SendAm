# SendAm

WhatsApp-first payments powered by the Stellar network.

SendAm is a financial access MVP that lets people create a Stellar wallet, check their XLM balance, and send XLM using simple WhatsApp messages. The goal is to make blockchain payments feel as familiar as sending a chat message, especially for users who may not be comfortable with browser wallets, seed phrases, or exchange-style interfaces.

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
   send 5 xlm GABC...
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
Next.js Web App
     |
     v
Express REST API
```

## Monorepo Structure

```text
SendAm/
  apps/
    api/       Express backend for WhatsApp, Stellar, MongoDB, and admin APIs
    web/       Next.js frontend for landing page, wallet testing, and admin dashboard
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

- Next.js 14
- React
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

1. User sends a command like `send 5 xlm GABC...`.
2. Backend parses amount and destination.
3. Backend decrypts the user's stored Stellar secret key.
4. Backend builds, signs, and submits a Stellar payment transaction.
5. Transaction result is saved in MongoDB.
6. User receives success or failure feedback on WhatsApp.

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
ENCRYPTION_KEY=your_64_character_hex_key
WHATSAPP_TOKEN=your_whatsapp_token_here
WHATSAPP_PHONE_NUMBER_ID=your_phone_id_here
WHATSAPP_VERIFY_TOKEN=your_verify_token
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
```

For the web app, configure:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:3002/api
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
npm run dev:web
```

The web app runs on:

```text
http://localhost:3000
```

### Run Both Apps

```bash
npm run dev
```

## Web App Pages

```text
/                 Landing page
/wallet-test      REST API wallet simulator
/admin/login      Admin login screen
/admin            Dashboard overview
/admin/users      User table
/admin/wallets    Wallet table
/admin/transactions Transaction table
```

## Security Notes

This project is still an MVP. Before any production or real-money launch, the following must be completed:

- Replace mock admin authentication with real backend authentication.
- Protect admin API routes with server-side authorization.
- Remove any fallback encryption key behavior.
- Validate Stellar public keys, amounts, phone numbers, and command payloads.
- Add transaction limits and abuse prevention.
- Add audit logs for sensitive actions.
- Add secure secret management for deployment.
- Complete legal, compliance, KYC, AML, and custody review where required.

## Current Limitations

- Uses Stellar Testnet only.
- Supports native XLM transfers only.
- WhatsApp command parser is intentionally simple.
- Admin login is currently mock/demo logic.
- No customer web signup is required yet because WhatsApp phone number is the MVP identity.
- No production compliance workflow is included yet.

## Roadmap

### MVP Completion

- Real admin authentication.
- Stronger validation for wallet and payment requests.
- Better WhatsApp command handling and error messages.
- Automated tests for parser, wallet, webhook, and transaction flows.
- Deployment configuration for backend, frontend, database, and environment variables.

### Stellar Product Expansion

- Support custom Stellar assets.
- Add contact aliases so users can send to saved recipients.
- Add transaction receipts with Stellar explorer links.
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

The project is intentionally scoped: it proves wallet creation, balance checks, and XLM transfer flows first. With stronger authentication, validation, compliance work, and production deployment, SendAm can evolve from a Testnet MVP into a broader payments product for mobile-first users.

## License

SendAm is open source and released under the MIT License. See `LICENSE` for details.
