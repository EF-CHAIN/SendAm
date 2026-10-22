# SendAm Chat Simulator

A React Native (Expo) app that drives the real WhatsApp assistant pipeline locally, without a
 WhatsApp Business account. You type a phone number, send commands, and get the same replies the
bot would send over Meta — so conversational and payment flows can be exercised end to end while
WhatsApp onboarding is still pending.

Part of the [SendAm](../../README.md) monorepo.

## What it does

The webhook is only a transport wrapper: all conversation and payment logic lives in
`apps/api/src/whatsapp/assistant.service.js#processMessage(phoneNumber, name, text)`. The
simulator is a **second front door to that same function**, not a fork of the bot:

```text
WhatsApp (production):  Meta webhook  ─┐
                                       ├─► processMessage() ─► orchestrator ─► Stellar
Chat simulator (local): POST /api/sim ─┘
```

Nothing in the pipeline changes between the two, so the simulator stays useful as the permanent
local-dev harness after Meta approval lands.

## Prerequisites

- Node.js 20 or newer (the repo pins the version in [`.nvmrc`](../../.nvmrc)).
- Dependencies installed from the **repository root** — this is an npm-workspaces monorepo, so
  `npm install` inside `apps/chat-sim` creates a partial tree that shadows the hoisted one.
- A running API with the simulator routes enabled (see "Server-side configuration" below).
- One of: iOS Simulator, Android Emulator, Expo Go on a physical device, or a web browser.

## Environment Variables

Optional — the app falls back to the API's default port, so this is only needed when the API is
not on `localhost`, for example when testing on a real device.

```env
EXPO_PUBLIC_API_BASE_URL=http://localhost:3002
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | `http://localhost:3002` | Base URL the simulator calls (see `src/config.js`) |

Expo inlines `EXPO_PUBLIC_*` variables at bundle time, so restart the dev server after changing
one — a reload alone will not pick it up.

## Develop

From the repository root:

```bash
npm install
npm run dev:api        # terminal 1 — http://localhost:3002
npm run dev:chat-sim   # terminal 2 — Metro on http://localhost:8081
```

In the Expo CLI output, press `w` for the browser build, `i` / `a` for the iOS / Android
simulators, or scan the QR code with Expo Go.

> **Note:** the root script is `dev:chat-sim` (it runs `expo start` in `apps/chat-sim`). There is
> no `dev:sim` script in this repo.

Equivalent commands from inside `apps/chat-sim`:

| Command | Runs |
| --- | --- |
| `npm start` | `expo start` |
| `npm run web` | `expo start --web` |
| `npm run ios` | `expo start --ios` |
| `npm run android` | `expo start --android` |
| `npm test` | `jest` (`jest-expo` preset) |

## Using the simulator

1. Enter a phone number in E.164 format; the field suggests `+2348000000001`. The number **is**
   the identity — the same way WhatsApp identifies a user — so wallet lookup, KYC status and
   payment state all resolve against it.
2. Send a command such as `balance`. Your message appears immediately (optimistic render).
3. The **ENGINE STATE** badge and the **Inspector** drawer expose the local payment state
   machine: current state, context JSON, and a timeline you can click to roll back to an earlier
   snapshot.
4. **Switch Account** clears the local session so you can start over as another number.
5. **Attachments & Media Preview**: Use the paperclip (📎) menu to attach a **Photo** or **Document** (e.g. for identity verification or receipt submission). Selecting a file opens an inline media preview bubble with caption support before sending, rendering a photo thumbnail or document card into the chat thread.

Voice input (**MIC**) and spoken replies (**Voice TTS**) use the Web Speech API, so they work in
the browser build only; on native builds `MIC` reports that speech recognition is unavailable.

## How the webhooks are mocked

| Direction | Real WhatsApp | In the simulator |
| --- | --- | --- |
| Inbound | Signed Meta webhook callback | Client `POST` to `/api/sim/message` |
| Outbound | WhatsApp Cloud API call | Captured by the pipeline's `notify` callback |

**Inbound.** There is no webhook and no signature verification. `src/api.js#sendMessage()` posts
`{ phoneNumber, name, text }`; the API validates the body, records the message as direction `in`,
and calls the real `processMessage`. (The composer in `src/ChatScreen.js` posts
`{ phoneNumber, text }` and omits `name`.)

**Outbound.** `handleMessage` passes a `notify` callback into the pipeline. Every reply the bot
produces — including async pushes, because they all route through the same callback — is appended
as direction `out` and returned inline in the response:

```json
{ "replies": ["Your SendAm balances: ..."] }
```

**Rendering.** `src/usePolling.js` polls `GET /api/sim/messages/:phone?since=<ISO date>` every
3 seconds, advancing the `since` cursor to the newest `createdAt` and merging remote rows into the
optimistic local list by matching text and sender, so sent messages are not duplicated.

Validation behaviour, verified against `apps/api/src/controllers/sim.controller.js`:

| Case | Result |
| --- | --- |
| `text` empty or missing | `400` `text is required` |
| `phoneNumber` invalid (`POST`) | `400` `A valid phoneNumber is required` |
| `phone` invalid (`GET`) | `400` `A valid phone number is required` |
| `since` not parseable as a date | `400` `since must be a valid ISO date` |

Note that `since` must be an ISO date, not a message id: the controller parses it with
`new Date(since)`, and an unparseable value is rejected with `400`.

## Server-side configuration

The routes live in the API but are mounted only when the feature is enabled, because they are
unauthenticated:

| Variable | Where | Default | Effect |
| --- | --- | --- | --- |
| `ENABLE_CHAT_SIM` | `apps/api/.env` | `true` outside production, `false` in production | Mounts `/api/sim/*`; enabling it in production logs a warning |
| `MESSAGE_TRANSPORT` | `apps/api/.env` | `meta` | With `sim`, outbound bot messages are persisted to the `SimMessage` table instead of being sent to Meta |

## Known limitation

The conversation the client reads back is kept in an **in-memory `Map`** inside
[`sim.controller.js`](../api/src/controllers/sim.controller.js) — an interim store, not the
`SimMessage` table. Three consequences:

- History is lost when the API process restarts.
- History is not shared between API instances.
- Messages written by the worker through the `sim` transport (for example deposit alerts) are **not**
  returned by `GET /api/sim/messages/:phone`, so they do not appear in the simulator today.

## Tests

```bash
npm test --workspace=apps/chat-sim
```

## Related documentation

- [`docs/CHAT-SIM.md`](../../docs/CHAT-SIM.md) — the API-side simulator contract
- [`docs/COMMANDS.md`](../../docs/COMMANDS.md) — every npm script and the port it serves
