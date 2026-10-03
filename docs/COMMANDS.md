# Command reference

Two kinds of commands live here: the **npm scripts** contributors run against
this repo, and the **bot commands** the conversational assistant understands.

## Project scripts (npm)

Audited against the root and every `apps/*` `package.json` (#461).
`packages/shared` defines no scripts. Run root scripts from the repo root;
per-app scripts either from the app directory or via
`npm run <script> --workspace=apps/<app>`.

### Root (`package.json`)

| Script | What it does |
|---|---|
| `npm run dev:api` | Start the API (`apps/api`) with nodemon reload |
| `npm run dev:worker` | Start the background worker (`apps/api`) with reload |
| `npm run dev:landing` | Start the landing site's Vite dev server |
| `npm run dev:admin` | Start the admin dashboard's Vite dev server |
| `npm run dev:chat-sim` | Start the Expo chat simulator |
| `npm run dev` | API + landing + admin in parallel (uses `&`, so POSIX shells only — on Windows run the three `dev:*` scripts in separate terminals) |
| `npm run build:landing` | Production build of the landing site |
| `npm run build:admin` | Production build of the admin dashboard |
| `npm run check-budgets` | Check built frontend bundle sizes against `scripts/check-frontend-budgets.js` budgets |
| `npm run lint` | ESLint across api, landing and admin |
| `npm test` | The API test suite (`node --test`) |
| `npm run test:landing` | The landing test suite (Vitest) |
| `npm run load -- <args>` | API load-test harness, forwarding `<args>` |
| `npm run install:all` | Alias for `npm install` (workspace install) |

### API (`apps/api/package.json`)

| Script | What it does |
|---|---|
| `npm start` | Run the API server (no reload) |
| `npm run start:worker` | Run the background worker (no reload) |
| `npm run dev` / `npm run dev:worker` | Same, with nodemon reload |
| `npm run lint` | ESLint over the API |
| `npm test` | Node's built-in test runner over the API suite |
| `npm run prisma:generate` | Regenerate the Prisma client after schema changes |
| `npm run prisma:migrate` | Create/apply a dev migration (`prisma migrate dev`) |
| `npm run prisma:deploy` | Apply committed migrations (`prisma migrate deploy`) — deploy environments |
| `npm run db:validate` | Validate a production database's state (internal-only: deploy tooling) |
| `npm run db:provision` | Migrate then validate, one shot (internal-only: deploy tooling) |
| `npm run db:verify-restore` | Backup restore drill (internal-only: ops runbook) |
| `npm run whatsapp:webhook:configure` | Point the WhatsApp webhook at this deployment (internal-only: ops) |

### Admin and landing (`apps/admin`, `apps/landing`)

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Production build |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | ESLint |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest watch mode (landing only) |

### Chat simulator (`apps/chat-sim`)

| Script | What it does |
|---|---|
| `npm start` | Expo dev server |
| `npm run android` / `npm run ios` / `npm run web` | Expo dev server targeting that platform |
| `npm test` | Jest suite |

## Bot command reference

What the conversational assistant (`apps/api/src/whatsapp/assistant.service.js`)
understands today. The same pipeline serves WhatsApp and the chat simulator —
commands are identical on both surfaces.

Matching is case-insensitive. Commands are plain text; voice notes are
transcribed (Deepgram, when configured) and fed through the same parser.

### Commands

| You type | What happens |
|---|---|
| `hi` / `hello` / `help` / `menu` | Capability overview |
| `balance` | Creates your wallet if needed, then shows your Stellar balance |
| `receive` | Shows your wallet address to share with a sender |
| `history` / `transactions` | Your last 5 transactions |
| `send 5 xlm <recipient>` | Prepares a transfer and asks for PIN confirmation |
| `<your PIN>` | Confirms the pending transfer |
| `no` / `cancel` | Cancels the pending transfer |

`pay` and `transfer` work as synonyms for `send`. The asset code is optional
(`send 5 <recipient>`) — the orchestrator falls back to the default asset.

### Recipients

A recipient in `send` can be, in resolution order:

1. **A saved contact name** — e.g. `send 5 xlm mama`. Saved contacts always
   win over everything else.
2. **A raw Stellar address** — a `G...` public key.

Anything that resolves to something other than a valid Stellar address is
rejected with a clear error before any money moves.

### The confirmation flow

Every send follows the same guarded path:

```
send 5 xlm GABC...
→ "Please confirm this payment: ... Reply with your PIN to send, or 'no' to cancel."
<PIN>
→ policy check (KYC tier limits, risk score) → payment submits → receipt
```

- The pending send **expires after 10 minutes**.
- The PIN is verified against your stored PIN hash. (Setting a PIN currently
  happens via `POST /api/compliance/pin`, which is local-testing-only — see
  the security notes in the README. Per-user PIN setup from chat is an open
  gap.)
- Confirmation is claim-based: two rapid PIN replies can never double-send.

### Known gaps (honest list)

- `save <name> <address>` and `contacts` appear in `services/agent/replies.js`
  copy but are **not wired** into the live pipeline yet — saved-contact
  resolution works only for aliases already present in the database.
- `fund` (retry Friendbot funding) is likewise copy-only right now.
- No PIN-setup command in chat (see above).

Each of these is a well-scoped contribution — check ISSUES.md before picking
one up.
