# Chat simulator

> **Status: SPEC.** WhatsApp onboarding is delayed on Meta's side, so the
> conversational surface is tested through a simulator. This document is the
> agreed interface for the implementation tracked in ISSUES.md **Epic 1**
> (backend, issues #5–#10) and **Epic 2** (Expo client, issues #11–#13).
> When those land, this page becomes the usage guide; until then, treat it
> as the contract implementers build against.

## Why it exists

The webhook (`webhook.controller.js`) is a thin transport wrapper — all
conversation and payment logic lives in
`assistant.service.js#processMessage(phoneNumber, name, text)`. The simulator
is a **second front door to that same function**, not a fork of the bot:

```
WhatsApp:   Meta webhook  ─┐
                           ├─► processMessage() ─► orchestrator ─► Stellar
Simulator:  POST /api/sim ─┘
```

When Meta approval lands, switching to production WhatsApp is one env var —
nothing in the pipeline changes, and the simulator stays as the permanent
local-dev harness.

## Backend interface

### Outbound transport seam

`MESSAGE_TRANSPORT=meta|sim` (default `meta`) in `apps/api/.env`:

- `meta` — outbound messages go to the WhatsApp Cloud API (current behavior).
- `sim` — outbound messages are written to the `SimMessage` table instead.
  This catches **everything** the bot says: direct replies *and* async
  pushes (deposit alerts), because both go through
  `whatsapp.service.js#sendTextMessage`.

### SimMessage model

```prisma
model SimMessage {
  id          String   @id @default(cuid())
  phoneNumber String
  direction   String   // "in" (user → bot) | "out" (bot → user)
  text        String
  createdAt   DateTime @default(now())

  @@index([phoneNumber, createdAt])
}
```

### Endpoints

Gated by `ENABLE_CHAT_SIM=true` (off by default; never enabled in production
with real funds — same pattern as `ENABLE_WALLET_REST_API`).

```
POST /api/sim/message
  body: { "phoneNumber": "+2348000000001", "name": "Ada", "text": "balance" }
  → runs the exact assistant pipeline
  → 200 { "replies": ["Your SendAm balances: ..."] }

GET /api/sim/messages/:phone?since=<ISO date or message id>
  → 200 { "messages": [ { direction, text, createdAt }, ... ] }
  → includes async pushes; poll this to render the conversation
```

The phone number in the body is the identity — deliberately identical to how
WhatsApp identifies users, so every downstream path (wallet lookup, KYC
tiers, rate limits) behaves exactly as in production.

## Expo client (`apps/chat-sim`)

Minimal single-screen chat app (scaffolded by the maintainer):

1. Enter a phone number (your simulated identity).
2. Type commands (see [`COMMANDS.md`](COMMANDS.md)); each send hits
   `POST /api/sim/message`.
3. A polling hook fetches `GET /api/sim/messages/:phone` every few seconds —
   replies and deposit alerts appear like incoming chat messages.

Config: API base URL in one config file — point it at
`http://localhost:3002` (or your deployed testnet API).

## Run it locally

Run the API and the simulator on your machine. Node.js 18+ and npm are
required (the steps below were checked on Node 24). Docker is only needed for
the optional local Postgres.

1. **Install dependencies** once, from the repo root (this is an npm
   workspace, so it installs the API and `apps/chat-sim` together):

   ```bash
   npm install
   ```

2. **Start a database.** The API needs a PostgreSQL `DATABASE_URL`. Either use
   the bundled local Postgres:

   ```bash
   docker compose up -d
   ```

   or point `DATABASE_URL` at any Postgres you already have.

3. **Configure the API.** Copy the example file and edit it:

   ```bash
   cp apps/api/.env.example apps/api/.env
   ```

   Set these values in `apps/api/.env`:

   | Variable | Value | Why |
   | --- | --- | --- |
   | `DATABASE_URL` | `postgresql://sendam:sendam@localhost:5432/sendam` (for the Docker Postgres; drop `sslmode=require`) | Database connection |
   | `ENCRYPTION_KEY` | output of `openssl rand -hex 32` | Required; the API refuses to start without a 32-byte hex key |
   | `JWT_SECRET` | output of `openssl rand -hex 32` | Required; at least 32 characters |
   | `MESSAGE_TRANSPORT` | `sim` | Writes outbound bot messages to `SimMessage` instead of calling Meta |
   | `ENABLE_CHAT_SIM` | `true` | Turns on `/api/sim/*`. The example file ships `false`; if unset it defaults to on outside production |
   | `PORT` | `3002` (already the default) | Must match the simulator's API URL |

   The WhatsApp variables in the example file can stay as placeholders while
   `MESSAGE_TRANSPORT=sim`.

4. **Create the schema and start the API** (still from the repo root):

   ```bash
   npm run prisma:generate --workspace=apps/api
   npm run prisma:deploy --workspace=apps/api
   npm run dev:api
   ```

   The API listens on `http://localhost:3002`. `GET /health` should respond
   once it is up.

5. **Start the simulator** in a second terminal, from the repo root:

   ```bash
   npm run dev:chat-sim
   ```

   This runs `expo start` in `apps/chat-sim` and serves Metro on
   `http://localhost:8081`. Press `w` for the web build, or scan the QR code
   with Expo Go. The other scripts in `apps/chat-sim/package.json` are
   `npm run android`, `npm run ios` and `npm run web` (use
   `--workspace=apps/chat-sim`).

6. **Try it.** Enter a phone number such as `+2348000000001`, then send
   `balance`. To check the API directly:

   ```bash
   curl -X POST http://localhost:3002/api/sim/message \
     -H 'content-type: application/json' \
     -d '{"phoneNumber":"+2348000000001","name":"Ada","text":"balance"}'
   ```

### Simulator configuration

`apps/chat-sim/src/config.js` reads one variable:

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | `http://localhost:3002` | Base URL of the API the simulator talks to |

The default only works when the simulator runs on the same machine as the API
(iOS simulator, web). Set it when the app runs elsewhere:

```bash
# Android emulator (host machine is 10.0.2.2)
EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:3002 npm run dev:chat-sim

# Physical device on the same Wi-Fi (use your computer's LAN IP)
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3002 npm run dev:chat-sim
```

Expo inlines `EXPO_PUBLIC_*` variables at bundle time, so restart the
Metro server after changing it.

## Two-device walkthrough (the MVP demo)

1. Device A, number `+234...01`: `balance` → wallet auto-created and funded.
2. Device B, number `+234...02`: `balance` → second wallet.
3. Device A: `send 5 xlm <B's address>` (or `+234...02` once phone-recipients
   land) → PIN → sent.
4. Device B: deposit alert appears via polling — loop closed, no Meta
   involved.

## Testing rules for implementers

- Transport seam: `sim` writes the store and **never** calls Meta; `meta`
  path byte-identical to today.
- Endpoints: flag off → blocked; invalid phone → rejected; replies returned
  in order.
- Poller-visible pushes: async sends land in `SimMessage` with
  `direction: "out"`.

See ISSUES.md for the per-issue test checklists.
