# SendAm

WhatsApp-first payments on Stellar with direct-custody wallets and voice-to-cash.

SendAm maps a WhatsApp phone number to a Stellar wallet and lets users send, receive, check balances, and request receipts from chat. The user experience hides blockchain complexity: the backend handles wallets, addresses, and settlement on Stellar so the user only ever talks to a chat assistant.

> Current status: the payment flow, direct-custody Stellar wallets, compliance models, background workers and admin dashboard are built and tested, but nothing here is approved for real-money operation yet. Live money movement still requires provider credentials, production KYC onboarding, deployment, and compliance review. [`ROADMAP.md`](ROADMAP.md) tracks each item as Built, Configured, Deployed or Approved.

## Product Direction

- WhatsApp conversational payment assistant.
- Voice note payment intents with transcription.
- Phone number as wallet identity — every user gets a Stellar wallet.
- Direct custody: keys generated and encrypted (AES-256-GCM) locally, not managed by a third-party provider.
- Stellar as the settlement layer, built for cross-border payment corridors.
- KYC, PIN verification, audit logs, limits, and risk scoring.
- BullMQ background processing for webhook, voice, receipt, and settlement jobs.

## Monorepo Structure

```text
SendAm/
  apps/
    api/       Express backend and worker-ready modules
    landing/   Vite + React public site
    admin/     Vite + React admin dashboard
    chat-sim/  WhatsApp chat simulator for local development (dev-only)
  packages/
    shared/    Shared frontend utilities and UI
```

The backend is organized toward:

```text
src/
  admin/          admin DTOs and helpers
  common/         audit and event services, Prisma client, validation
  compliance/     KYC tiers, limits, PIN, risk scoring
  config/         env validation, Stellar/Horizon, Redis, deployment manifest
  controllers/    HTTP controllers (webhook, wallet, admin, sim, ...)
  errors/         AppError, error catalog and response envelope
  i18n/           reply message catalogs and formatters
  jobs/           background job handlers (deposits, DLQ, retention, ...)
  middlewares/    requireAdmin, rate limiting, error handling
  observability/  metrics, alerting, worker health
  payment/        payment orchestrator
  pricing/        FX and quote service
  queues/         BullMQ queue service
  routes/         Express routers
  services/       WhatsApp transport, crypto, REST auth, rate limits, ...
  support/        privacy and wallet-troubleshooting services
  utils/          logger, money, pagination and response helpers
  voice/          voice-note download and transcription
  wallet/         Stellar adapter and wallet service
  webhooks/       webhook idempotency
  whatsapp/       conversational assistant and webhook validation
```

## Backend Modules

- `wallet`: Direct-custody Stellar adapter plus a `WalletService` abstraction for create/get wallet, send, balance, and transaction history. App code never imports the Stellar SDK directly — only `stellar.adapter.js` does.
- `payment`: Payment Orchestrator for quotes, fees, transaction execution, and receipts. Settlement is Stellar-only.
- `whatsapp`: Conversational assistant for send money, receive money, balance, contacts, history, and receipts.
- `voice`: WhatsApp audio download and Deepgram transcription pipeline.
- `compliance`: KYC tiers, transaction limits, PIN verification, and risk scoring.
- `pricing`: FX/quote service hooks for ExchangeRate API and CoinGecko.
- `queues/jobs`: BullMQ processors for asynchronous webhook and voice processing.
- `admin`: Monitoring endpoints for transactions, KYC, audit logs, and system health.

## WhatsApp Message Payloads

SendAm talks to the WhatsApp Business Cloud API directly from `apps/api/src/services/whatsapp.service.js`. Every outbound call is a `POST` to
`https://graph.facebook.com/<META_GRAPH_API_VERSION | v19.0>/<WHATSAPP_PHONE_NUMBER_ID>/messages` with `Authorization: Bearer <WHATSAPP_TOKEN>`.

This section documents the payload shapes the code actually sends and accepts, including what happens to interactive (quick-reply button / list picker) messages. See [`docs/PRODUCTION-WHATSAPP-WEBHOOK.md`](docs/PRODUCTION-WHATSAPP-WEBHOOK.md) for the webhook, secrets, and rollout runbook, and [`docs/COMMANDS.md`](docs/COMMANDS.md) for the user-facing command reference.

### Outbound: what SendAm sends today

**Plain text** — `sendTextMessage()` is the only payload used for conversation replies (menus, balances, receipts, confirmation prompts):

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "15551234567",
  "type": "text",
  "text": {
    "preview_url": false,
    "body": "Please confirm this payment: ... Reply with your PIN to send, or \"no\" to cancel."
  },
  "biz_opaque_callback_data": "correlation-id-for-log-matching"
}
```

`biz_opaque_callback_data` carries the send's correlation id (truncated to 512 characters) so Meta's delivery-status callbacks can be matched back to logs; `preview_url` is always `false`.

**Template** — `sendTemplateMessage()`. Required once Meta's 24-hour customer service window has closed, because free-form text is rejected outside it:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "15551234567",
  "type": "template",
  "template": {
    "name": "payment_window_reopened",
    "language": { "code": "en" },
    "components": []
  }
}
```

`components` is omitted entirely when empty. `sendTextMessage()` enforces the 24-hour rule only when a caller passes `enforceWindow: true` together with the user's `lastCustomerInteractionAt`.

Setting `MESSAGE_TRANSPORT=sim` short-circuits both senders into the local `SimMessage` table instead of Meta — that is what the chat simulator and the test suite use.

### Interactive (button and list) messages

**SendAm does not emit interactive messages today.** The Cloud API surfaces below are the canonical payloads a quick-reply button or list picker uses. They are documented here so developers know the exact structures a future implementation must produce and so the inbound side is unambiguous. The only reference to `interactive` in the repo is the inbound allow-list in `apps/api/src/whatsapp/webhook.validator.js`.

**Reply buttons** (`type: "button"`, up to 3 buttons):

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "15551234567",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "header": { "type": "text", "text": "Confirm transfer" },
    "body": { "text": "Send 5 XLM to ada?" },
    "footer": { "text": "This request expires in 10 minutes." },
    "action": {
      "buttons": [
        { "type": "reply", "reply": { "id": "confirm_send", "title": "Confirm" } },
        { "type": "reply", "reply": { "id": "cancel_send", "title": "Cancel" } }
      ]
    }
  }
}
```

**List picker** (`type: "list"`, one level of sections and rows):

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "15551234567",
  "type": "interactive",
  "interactive": {
    "type": "list",
    "header": { "type": "text", "text": "Choose an asset" },
    "body": { "text": "Which asset do you want to send?" },
    "action": {
      "button": "Choose",
      "sections": [
        {
          "title": "Assets",
          "rows": [
            { "id": "asset_xlm", "title": "XLM", "description": "Stellar native asset" },
            { "id": "asset_usdc", "title": "USDC", "description": "USD Coin on Stellar" }
          ]
        }
      ]
    }
  }
}
```

Field limits that matter: a button `title` is at most 20 characters and its `id` at most 256; a list action `button` label is at most 20 characters, with up to 10 sections and 10 rows in total, row `title` at most 24 characters and `description` at most 72; `body.text` is at most 1024 characters; `header` and `footer` are optional.

**Inbound replies** to either surface arrive as `messages[].interactive`:

```json
{
  "type": "interactive",
  "interactive": {
    "type": "button_reply",
    "button_reply": { "id": "confirm_send", "title": "Confirm" }
  }
}
```

`list_reply` has the same shape with `{ "id", "title", "description" }`. `validateInboundMessage()` accepts `interactive`, but `processMessage()` in `apps/api/src/controllers/webhook.controller.js` only handles `text`, `audio`, and `voice`, so an interactive reply is currently acknowledged and dropped with the `unsupported` outcome. Wiring buttons in means (a) adding an interactive sender in `whatsapp.service.js` and (b) translating `button_reply.id` / `list_reply.id` into the text tokens the assistant already understands.

### Action IDs

SendAm has no button IDs yet, so the "action id" for every flow is a **plain-text token** parsed by `apps/api/src/whatsapp/assistant.service.js`. These are the values an interactive implementation would map button IDs onto:

| Flow | Token(s) | Handler |
| --- | --- | --- |
| Transfer / quote confirmation | any digits (the user's PIN), or `no` / `cancel` to cancel | `handlePendingPin()` |
| High-risk recipient confirmation | `yes` / `oui` / `si` to confirm; anything else returns the invalid-reply prompt | `handlePendingPin()` |
| Cancel a pending send | `no` / `cancel` | `handlePendingPin()` |
| Menu / capabilities | `hi`, `hello`, `help`, `menu` | `processMessage()` |
| Balance | `balance` | `processMessage()` |
| Receive address | `receive` | `processMessage()` |
| Transaction history | `history`, `transactions` | `processMessage()` |
| Prepare a transfer | `send` / `pay` / `transfer <amount> [asset] <recipient>` | `parsePaymentIntent()` |
| Locale / account language switch | `lang <code>`, `language <code>`, `locale <code>` (`en`, `fr`, `es`) | `processMessage()` |
| Consent opt-out / opt-in | `STOP` / `START` keywords | `parseConsentCommand()` |

Two flows that are often assumed to be buttons are worth calling out:

- **KYC trigger** — there is no chat command or action id for KYC. Verification is started through `POST /api/compliance/kyc/start`, which has no per-user authentication and is disabled in production by default (see the security notes below).
- **Account switch** — SendAm has a single wallet per user; the closest command is the locale switch above. There is no multi-account switcher in the assistant.

### Fallback behavior without interactive support

- Every SendAm flow is text-first, so a WhatsApp client that does not render interactive elements loses nothing: the same commands and confirmation tokens are sent as messages and voice notes.
- Inbound types other than `text`, `audio`, and `voice` — including `interactive`, `location`, `image`, `document`, and `sticker` — pass schema validation but are dropped as `unsupported` instead of failing the batch.
- Outside Meta's 24-hour customer service window, free-form text is refused: the caller must supply an approved `templateName` (the template payload above) or the send is recorded as a permanent failure with `Meta customer service window expired (24h). Approved template required.`
- When a sender exceeds the per-sender rate limit, the bot sends one `replies.rateLimited()` notice and then stays quiet, rather than returning a non-2xx that would make Meta retry the webhook.

## API Summary

```text
POST /api/wallet/create
GET  /api/wallet/:phone/balance
GET  /api/wallet/:phone/transactions
POST /api/wallet/send

POST /api/pricing/quote

GET  /api/compliance/kyc/:phone
POST /api/compliance/kyc/start
POST /api/compliance/kyc/:id/review
POST /api/compliance/pin

GET  /api/admin/stats
GET  /api/admin/users
GET  /api/admin/wallets
GET  /api/admin/transactions
GET  /api/admin/kyc
GET  /api/admin/audit-logs
GET  /api/admin/system-health
GET  /api/auth/challenge          SEP-10 style challenge for REST clients
POST /api/auth/token
POST /api/auth/logout
GET  /api/receipts/:id            public receipt verification
GET  /api/receipts/:id/verify
GET  /webhook
POST /webhook
```

`/api/admin/*` has many more routes than listed here (exports, DLQ, privacy requests, legal holds, administrators, events, compliance evidence); they are permission-gated by `requireAdmin(<permission>)` in `apps/api/src/routes/admin.routes.js`, which is the source of truth. `/api/sim/*` exists only when `ENABLE_CHAT_SIM=true` (dev harness, see [`docs/CHAT-SIM.md`](docs/CHAT-SIM.md)).

## Infrastructure Target

- Frontend: Vercel
- Backend API: Railway
- Workers: Railway or another long-running worker host, not Vercel
- Database: Neon PostgreSQL with Prisma
- Redis: Upstash
- Storage: Cloudflare R2

## Environment Variables

Use `apps/api/.env.example` as the source of truth. The local `apps/api/.env` has been expanded with blank keys for Redis, R2, pricing, KYC, ramps, and voice providers so secrets can be filled in later.

> The REST wallet API (`/api/wallet/*`) is unauthenticated and is disabled in production unless `ENABLE_WALLET_REST_API=true`. Outside production it defaults to enabled for local testing. WhatsApp is the real, signature-verified surface.

### Frontend build-time variables (Vercel)

Vite inlines `import.meta.env.VITE_*` into the bundle **at build time**, so these are not runtime
configuration: changing one in the Vercel dashboard has no effect until the project is redeployed.
Only the `VITE_` prefix is exposed to the browser — a variable without it (for example
`NON_VITE_SECRET`) is never inlined into `dist/`, which is why no secret may ever be given that
prefix.

| Variable | App | Required | Local default | Production (Vercel) | Read by |
| --- | --- | --- | --- | --- | --- |
| `VITE_API_BASE_URL` | `apps/admin` | Yes, for a deployed admin | `http://localhost:3002/api` | `https://<api-host>/api` | `packages/shared/src/api.js` (axios `baseURL`) |
| `VITE_ADMIN_URL` | `apps/landing` | No | `http://localhost:3001` | `https://admin.<domain>` | `apps/landing/src/lib/links.js` (nav, hero and CTA links) |
| `VITE_WHATSAPP_NUMBER` | `apps/landing` | No | empty (falls back to `https://wa.me/`, letting WhatsApp pick the chat) | digits only with country code, no `+` (for example `2348012345678`) | `apps/landing/src/lib/links.js` (`whatsappUrl()`) |
| `VITE_WS_URL` | `apps/admin` | No | derived as `ws://` or `wss://<current-hostname>:3002/ws` | `wss://<api-host>/ws` | `apps/admin/src/lib/websocket.js` (`getDefaultUrl()`) |

Notes for the deployment checklist:

- `VITE_ADMIN_URL` treats an unset, empty, or whitespace-only value as "not configured" and falls
  back to `http://localhost:3001` (see `normalizeAdminUrl()`), so a half-filled value silently
  points the landing CTAs at localhost. Set the full origin, including the scheme.
- `VITE_WHATSAPP_NUMBER` ships empty in `apps/landing/.env.example`. Left empty, the CTA opens
  `https://wa.me/` and WhatsApp asks the user to pick a chat; it is the only way to deep-link
  straight to the SendAm bot.
- `VITE_WS_URL` is read by the admin websocket client but is **not** present in
  `apps/admin/.env.example`. Leave it unset unless the API's websocket is served from a different
  host or path than `<admin-host>:3002/ws`; the default already matches the local API port.
- No analytics variable is consumed by the frontend today — a repo-wide search for `VITE_*` in
  application source returns only the four variables above. Adding one (for example a Vercel
  Analytics or Sentry DSN) requires a code change first; setting the variable alone does nothing.

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

- Node.js 20.19 or newer (see `.nvmrc`; Prisma 7 needs 20.19+). The Expo simulator in `apps/chat-sim` needs 22.13+.
- npm
- A PostgreSQL connection string for `DATABASE_URL` — either a local Postgres
  via Docker Compose (below) or a cloud database (e.g. Neon)
- Docker, if using the local Postgres option
- WhatsApp Business Cloud API credentials for webhook testing

### Local Postgres (no cloud account needed)

A `docker-compose.yml` at the repo root runs a local Postgres so you don't
need a Neon (or any cloud) account to get started:

```bash
docker compose up -d
```

Then in `apps/api/.env`, set:

```env
DATABASE_URL=postgresql://sendam:sendam@localhost:5432/sendam
```

(Skip `sslmode=require` from the `.env.example` placeholder — the local
container doesn't use SSL.)

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

### Complete Local Dev Walkthrough

`chat-sim` talks to the same `assistant.service.js#processMessage` pipeline the WhatsApp webhook does, so a full round trip can be exercised with no Meta account. Finish [Prerequisites](#prerequisites), [Local Postgres](#local-postgres-no-cloud-account-needed) and [Install Dependencies](#install-dependencies) first, then run the four steps below in separate terminals. The simulator's own contract lives in [`docs/CHAT-SIM.md`](docs/CHAT-SIM.md).

**1. Start Postgres and the API.** Copy the env template and fill in the minimum set:

```bash
cp apps/api/.env.example apps/api/.env
```

| Variable | Local value | Why |
|---|---|---|
| `DATABASE_URL` | `postgresql://sendam:sendam@localhost:5432/sendam` | The Docker Postgres above; drop `sslmode=require` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | The API refuses to start without 32 bytes of hex |
| `JWT_SECRET` | `openssl rand -hex 32` | Must be at least 32 characters |
| `ENABLE_CHAT_SIM` | `true` | Mounts `/api/sim/*`; the template ships `false` |
| `MESSAGE_TRANSPORT` | `sim` | Writes outbound sends to the `SimMessage` table instead of calling Meta |
| `ADMIN_PASSWORD` | any **12+ character** string | Step 4 login; shorter passwords are rejected when the account is hashed |
| `ADMIN_BOOTSTRAP_EMAIL` | `admin@example.com` | The identity that shared password bootstraps |

```bash
npm run prisma:generate --workspace=apps/api
npm run prisma:deploy --workspace=apps/api
npm run dev:api            # http://localhost:3002
```

**2. Start the chat simulator.**

```bash
npm run dev:chat-sim       # Expo Metro on http://localhost:8081
```

Press `w` for the browser build, or scan the QR code with Expo Go. The API base URL comes from `EXPO_PUBLIC_API_BASE_URL` in `apps/chat-sim/src/config.js` and defaults to `http://localhost:3002`; set it to your LAN IP (physical device) or `http://10.0.2.2:3002` (Android emulator) and restart Metro, since Expo inlines it at bundle time.

**3. Send a test prompt.** Enter a phone number such as `+2348000000001` and send `balance`. The first message creates that `User`, `balance` provisions the wallet, and the reply returns inline:

```bash
curl -X POST http://localhost:3002/api/sim/message \
  -H 'content-type: application/json' \
  -d '{"phoneNumber":"+2348000000001","name":"Ada","text":"balance"}'
# 200 {"replies":["Your SendAm balances: ..."]}
```

This is exactly what the simulator does on each send; `help` lists the other commands — see [`docs/COMMANDS.md`](docs/COMMANDS.md).

**4. Inspect the result in the admin dashboard.** Set `VITE_API_BASE_URL=http://localhost:3002/api` in `apps/admin/.env` (see [Local Development](#local-development)), then:

```bash
npm run dev:admin          # http://localhost:3001
```

Sign in with `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_PASSWORD`. The first successful sign-in mints the bootstrap administrator and forwards you to `/set-password`: an account created from the shared password is refused by every admin route (403, `PASSWORD_CHANGE_REQUIRED`) until it has a private password. **Users** and **Wallets** then list the identity and wallet created in step 3; **Transactions** lists completed transfers, each row opening `/transactions/:id`.

Two things that trip people up:

- `balance` creates a user and a wallet, **not** a transaction. Rows appear under **Transactions** only after a completed `send 5 xlm <address>` plus PIN confirmation — see [the confirmation flow](docs/COMMANDS.md#the-confirmation-flow).
- The conversation the simulator renders (`GET /api/sim/messages/:phone`) is kept in an in-memory `Map` in `sim.controller.js`, not in the `SimMessage` table: it resets when the API restarts and is not shared between API instances. Wallets and transactions themselves are persisted in Postgres, so they survive a restart.

## Production Readiness Gaps

- ~~Support non-native Stellar assets via `changeTrust` (USDC and anchor-issued assets)~~ — **Done.** XLM and USDC are both built; `resolveAsset('USDC')`, `getBalances()`, and `establishTrustline()` are in the adapter and wallets auto-open the USDC trustline at creation. See [`ROADMAP.md`](ROADMAP.md#usdc--non-native-asset-support--built).
- Wire Smile ID or Dojah production KYC callbacks.
- Apply the Prisma migration to the Neon database and run provider-level smoke tests.
- ~~Split background workers from the API process in deployment~~ — **Done.** The root `Procfile` declares separate `web` and `worker` processes; see [`docs/BACKGROUND-WORKERS.md`](docs/BACKGROUND-WORKERS.md) for the rollout order.
- Expand automated test coverage for the payment orchestrator, voice, and compliance flows (webhook and auth integration tests exist — see [`ROADMAP.md`](ROADMAP.md#test-coverage)).
- Wire alerting (`queueAlerting.service.js`, [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md)) to a real on-call channel and add audit review workflows. Admin accounts and role-based permissions (`AdminUser`, `AdminRole`) are already built.
- Build real per-user authentication for the compliance PIN and KYC-start endpoints — they're gated off in production by default (`ENABLE_WALLET_REST_API`, same as the wallet REST API) until then, so they have no working production path yet.

### Run The Tests

The backend uses Node's built-in `node:test` runner (no extra test framework dependency). The suite covers unit and integration scenarios: wallet-key encryption, admin auth, request validators, Stellar adapter, multi-asset balances, USDC trustlines, full webhook flow, SEP-10 auth routes, authenticated REST routes, deposit polling, idempotency, payment orchestration, compliance service, and KYC lifecycle.

```bash
npm test                            # from the repo root
npm run test --workspace=apps/api   # equivalently
```

The other workspaces have their own suites. CI runs the admin, landing and chat-sim ones; `test:shared` and the Playwright suites are run locally (`test:visual` has its own workflow):

```bash
npm run test:admin       # admin dashboard (Vitest + jest-axe)
npm run test:landing     # landing site (Vitest + jest-axe)
npm run test:shared      # packages/shared
npm test --workspace=apps/chat-sim   # chat simulator (Jest + jest-expo)
```

Playwright suites: `npm run test:e2e:landing`, `test:e2e:admin`, `test:e2e:chat-sim`, and `npm run test:visual`.

CI also fails a PR that touches `apps/api/src/**` without touching `apps/api/test/**` (see the `api-test-coverage` job in `.github/workflows/ci.yml`). It's a crude heuristic — maintainers can override — meant to catch untested backend changes before merge.

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
/onboarding       Onboarding readiness checkpoints and identity status
*                 404 page for any unmatched URL
```

Admin app (`apps/admin`):

```text
/login            Admin login screen
/set-password     Forced admin password rotation screen
/                 Dashboard overview
/users            User table
/wallets          Wallet table
/transactions     Transaction table
/transactions/:id Transaction detail (receipt export, XDR decoder)
/kyc              KYC review
/audit-logs       Audit logs
/system-health    System health
*                 Any other path renders the Dashboard
```

Routes are declared in `apps/landing/src/App.jsx` and `apps/admin/src/App.jsx`.

- `/transactions/:id` takes a transaction id — open it by clicking a row on
  `/transactions` or by picking a result in the admin global search.
- `/login` and `/set-password` render **outside** the admin shell, so they have
  no sidebar navigation. `/set-password` is where an operator replaces a
  bootstrap or rotated credential; the new password must be at least 12
  characters.
- The admin `*` route renders the Dashboard **inside** the admin shell, so an
  unknown admin path looks like a working page rather than a 404.
- `/onboarding` reads `GET /api/compliance/onboarding`, which requires an
  authenticated REST session. Without one the API answers 401/403 and the page
  falls back to a built-in sample checklist so it stays demoable.

## Security Notes

This project is a work-in-progress platform expansion. Some hardening is already in place:

- Real backend admin authentication (HMAC-signed session tokens); the API refuses to start without `ADMIN_PASSWORD` and `JWT_SECRET`.
- Admin API routes protected server-side by the `requireAdmin` middleware, with per-administrator accounts and role-based permissions (`admin.read`, `compliance.read/write`, `operations.write`).
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
- Expand the automated test suite to cover the payment orchestrator, wallet, webhook, voice, and compliance flows.
- Complete legal, compliance, KYC, AML, and custody review where required.

## License

MIT. See `LICENSE`.
