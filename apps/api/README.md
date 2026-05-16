# SendAm Backend API

The SendAm backend is the payment engine behind the WhatsApp-first Stellar wallet MVP. It receives WhatsApp webhook events, parses user commands, creates Stellar Testnet wallets, checks balances, sends XLM, stores transaction records, and exposes admin data for the web dashboard.

> Current status: Testnet MVP. This backend should not be used for real-money production transactions until authentication, validation, monitoring, and compliance work are completed.

## What This API Does

- Receives WhatsApp Business webhook messages.
- Converts simple text commands into wallet actions.
- Creates Stellar keypairs for new users.
- Encrypts and stores Stellar secret keys.
- Funds new Testnet wallets using Stellar Friendbot.
- Checks native XLM balances through Stellar Horizon.
- Builds, signs, and submits XLM payment transactions.
- Stores users, wallets, and transactions in MongoDB.
- Provides REST endpoints for the Next.js wallet simulator.
- Provides admin endpoints for dashboard statistics and tables.

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
hi
hello
help
create wallet
balance
send 5 xlm GABC...
```

## Main Flow

### Wallet Creation

1. User sends `create wallet` on WhatsApp.
2. Backend creates or finds the user by phone number.
3. Backend generates a Stellar keypair.
4. Secret key is encrypted before storage.
5. Wallet public key is stored in MongoDB.
6. Testnet wallet is funded through Friendbot.
7. User receives their public key by WhatsApp.

### Balance Check

1. User sends `balance`.
2. Backend finds the wallet connected to the user's phone number.
3. Backend loads the Stellar account from Horizon.
4. User receives their XLM balance.

### XLM Transfer

1. User sends `send <amount> xlm <destination>`.
2. Backend parses the amount and destination public key.
3. Backend decrypts the stored Stellar secret key.
4. Backend builds and signs a Stellar payment transaction.
5. Transaction is submitted to Stellar Horizon.
6. Transaction status and hash are stored in MongoDB.
7. User receives a WhatsApp success or failure message.

## Tech Stack

- Node.js
- Express
- MongoDB with Mongoose
- `@stellar/stellar-sdk`
- WhatsApp Business Cloud API
- Axios
- Helmet
- CORS
- Morgan
- Express rate limiting

## Folder Structure

```text
apps/api/
  src/
    config/        Environment, database, and Stellar configuration
    controllers/   Webhook, wallet, and admin request handlers
    middlewares/   Error handling, not-found handling, webhook verification
    models/        Mongoose models for users, wallets, and transactions
    routes/        Express route definitions
    services/      WhatsApp, Stellar, wallet, parser, and crypto services
    utils/         Response helpers, logger, and validators
    app.js         Express app setup
    server.js      Database connection and server start
```

## API Routes

### WhatsApp Webhook

```text
GET  /webhook
POST /webhook
```

The `GET /webhook` route is used by WhatsApp to verify the webhook. The `POST /webhook` route receives incoming WhatsApp messages.

### Wallet Routes

```text
POST /api/wallet/create
GET  /api/wallet/:phone/balance
POST /api/wallet/send
```

These routes allow the frontend wallet simulator to test the same wallet actions without going through WhatsApp.

### Admin Routes

```text
GET /api/admin/stats
GET /api/admin/users
GET /api/admin/wallets
GET /api/admin/transactions
```

These routes power the admin dashboard.

## Environment Variables

Create an `.env` file in `apps/api` using `.env.example` as a guide:

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

`ENCRYPTION_KEY` must be a 64-character hexadecimal string because the app uses AES-256-CBC for encrypting Stellar secret keys.

You can generate a development key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
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

The backend runs on:

```text
http://localhost:3002
```

## Testing The REST API

Create a wallet:

```bash
curl -X POST http://localhost:3002/api/wallet/create ^
  -H "Content-Type: application/json" ^
  -d "{\"phoneNumber\":\"+2348000000000\"}"
```

Check balance:

```bash
curl http://localhost:3002/api/wallet/+2348000000000/balance
```

Send XLM:

```bash
curl -X POST http://localhost:3002/api/wallet/send ^
  -H "Content-Type: application/json" ^
  -d "{\"phoneNumber\":\"+2348000000000\",\"amount\":\"5\",\"destination\":\"GDESTINATIONPUBLICKEY\"}"
```

## Testing WhatsApp Webhooks Locally

To test WhatsApp webhooks on a local machine:

1. Start the backend on port `3002`.
2. Expose the backend with `ngrok` or `localtunnel`.
3. Configure the WhatsApp Business webhook URL as:

```text
https://your-public-url/webhook
```

4. Set the same verify token in WhatsApp and `WHATSAPP_VERIFY_TOKEN`.
5. Send a WhatsApp message to the configured business number.

## Security And Production Requirements

Before production launch, this backend needs:

- Real admin authentication and authorization.
- Protected admin API routes.
- Strong input validation for phone numbers, amounts, and Stellar public keys.
- Balance and fee checks before submitting transactions.
- Confirmation flows for risky transactions.
- Removal of fallback encryption keys.
- Secure secret management for deployment.
- Per-user and per-IP rate limits.
- Audit logs for wallet and transaction actions.
- Monitoring, alerting, and structured production logs.
- Legal, compliance, KYC, AML, and custody review where required.

## Current Limitations

- Stellar Testnet only.
- Native XLM transfers only.
- Simple command parser.
- No real admin authorization at the API layer yet.
- No customer web login or signup yet because WhatsApp phone number is the current MVP identity.
- No production compliance workflow yet.

## Reviewer Summary

This backend proves the most important SendAm concept: a user can interact with Stellar payments through WhatsApp. It demonstrates wallet creation, Testnet funding, balance lookup, XLM transfer submission, transaction storage, and admin observability.

The next major step is hardening the system for real users through authentication, validation, testing, monitoring, and compliance review.
