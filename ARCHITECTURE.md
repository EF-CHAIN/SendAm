# Architecture

This document describes how SendAm is structured internally: the chain-adapter
pattern that lets it support more than one blockchain, and the boundary
between what ships in this open-source repository and what runs as a
privately-operated service.

## Chain adapters

SendAm's product surface (WhatsApp commands, wallet records, transaction
history, admin dashboard) is chain-agnostic. Blockchain-specific logic is
isolated behind a small adapter interface in `apps/api/src/services/chains/`:

```js
{
  chain,                                  // 'stellar' | 'lisk'
  createWallet(),                         // -> { publicKey, secretKey }
  getBalance(publicKey),                  // -> native-asset balance
  submitPayment({ secretKey, destination, amount, asset }),
  resolveAsset(assetCode),
  validateAddress(address),
  fundTestnetAccount(publicKey),          // testnet-only convenience
}
```

Each supported chain implements this interface once (`stellar.adapter.js`,
`lisk.adapter.js`). The rest of the codebase — command handling, guardrails,
the confirm-before-send flow, admin reporting — talks to `resolveAdapter(chain)`
and never imports a chain SDK directly. Adding a new chain means writing one
adapter, not touching the product logic.

Destination chain is inferred from address shape (a Stellar `G...` StrKey vs.
an EVM `0x...` address), so a user never has to declare which chain they mean
— every user gets both a Stellar and a Lisk wallet by default, and `send`
routes automatically.

## What's open vs. what's a private service

Everything that makes SendAm's Stellar and Lisk integrations work is in this
repository: wallet creation, balance checks, payment submission, address
validation, the WhatsApp command flow, and the admin dashboard. That's
deliberate — the parts of the system that plug directly into each chain are
exactly what should be open and reviewable.

A few capabilities depend on infrastructure that has to run privately —
holding real funds, or configuration that shouldn't ship in a public repo —
and this repo only contains a thin, well-defined client for them. If the
private service isn't configured, the feature degrades gracefully (clearly
logged, no crash) rather than failing silently.

| Capability | In this repo | Runs privately |
|---|---|---|
| Stellar wallet / balance / send | Full implementation | — |
| Lisk wallet / balance / send | Full implementation | — |
| Cross-chain settlement (bridge) | Adapter interface + Stellar-leg client | Treasury custody, routing execution |
| Gas sponsorship (paymaster) | Thin client, calling contract only | Funded gas wallet, relayer signing |
| AI-assisted command parsing | Generic call + structured-output parsing | The tuned system prompt (versioned, stored server-side) |

The AI intent decoder is worth calling out specifically: it only ever
*proposes* a parsed command. Every proposal — whether it came from the
regex-based parser or the AI fallback — flows through the same deterministic
guardrails (per-transaction and rolling 24-hour limits, balance checks, and
an explicit user confirmation) before any funds move. The model never
executes a transaction directly.

## Why this shape

- **Reviewability.** Anyone can read exactly how SendAm talks to Stellar and
  Lisk, because that code is the whole point of being open source here.
- **Safety.** Capabilities that hold real value (a bridge treasury, a funded
  gas wallet) aren't distributed in a public repository's environment
  configuration — they're operated as services with their own access
  control.
- **Extensibility.** The adapter interface is the seam for the next chain,
  the next asset, or a SEP-10/Soroban-based Stellar feature — it slots in
  without touching unrelated code.
