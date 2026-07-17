# Bot command reference

What the conversational assistant (`apps/api/src/whatsapp/assistant.service.js`)
understands today. The same pipeline serves WhatsApp and the chat simulator —
commands are identical on both surfaces.

Matching is case-insensitive. Commands are plain text; voice notes are
transcribed (Deepgram, when configured) and fed through the same parser.

## Commands

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

## Recipients

A recipient in `send` can be, in resolution order:

1. **A saved contact name** — e.g. `send 5 xlm mama`. Saved contacts always
   win over everything else.
2. **A global name** — `@ada` or `ada*sendam.app`, resolved through the
   naming service **only when `ENABLE_NS_RESOLUTION=true`**. Bare names are
   never sent to the naming service.
3. **A raw Stellar address** — a `G...` public key.

Anything that resolves to something other than a valid Stellar address is
rejected with a clear error before any money moves.

## The confirmation flow

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

## Known gaps (honest list)

- `save <name> <address>` and `contacts` appear in `services/agent/replies.js`
  copy but are **not wired** into the live pipeline yet — saved-contact
  resolution works only for aliases already present in the database.
- `fund` (retry Friendbot funding) is likewise copy-only right now.
- No PIN-setup command in chat (see above).

Each of these is a well-scoped contribution — check ISSUES.md before picking
one up.
