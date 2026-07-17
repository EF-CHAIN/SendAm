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
