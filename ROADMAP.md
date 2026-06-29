# Roadmap

This is the detailed, public roadmap for SendAm. For the "why" behind the
architecture referenced below, see [`ARCHITECTURE.md`](ARCHITECTURE.md). The
top-level [`README.md`](README.md) keeps a short summary; this file is the
full picture, kept current as work lands.

Status labels used throughout:

- **Built** — code exists in this repo and is tested.
- **Deployed** — built, and actually running somewhere reachable.
- **Planned** — not started yet.

Built is not the same as live. A feature can be fully built and still not do
anything for a real user until it's deployed and configured — that gap is
called out explicitly wherever it applies, rather than left implied.

---

## Where things stand today

### Core Stellar product — Deployed (Testnet)

Wallet creation, balance checks, saved contacts, confirmation-based XLM
transfers, admin dashboard. This is the working MVP described in the
[README](README.md#product-overview).

### Multi-chain foundation (Lisk) — Built, not yet deployed

- Chain-adapter pattern (`apps/api/src/services/chains/`): Stellar and Lisk
  behind one interface, product code never imports a chain SDK directly.
- Every user gets a Stellar **and** a Lisk wallet on `create wallet` — no
  "pick a chain" step.
- `balance` reports both chains; `send <amount> <asset> <address-or-name>`
  detects the destination chain from address shape and routes automatically.
- Known gap, not hidden: Lisk Sepolia (testnet) has no Friendbot-equivalent
  auto-fund API. New Lisk wallets are created but not auto-funded — the bot
  gives manual faucet instructions instead of pretending funding happened.

**To go live:** deploy the updated backend, then this is usable immediately
on testnet.

### AI-assisted command parsing — Built, not yet active

A structured-output fallback (regex parser first; the AI decoder only runs
when the regex parser can't confidently classify a message) that turns
natural-language WhatsApp text into the same intent shape a typed command
produces. Its output always flows through the same guardrails and
confirmation flow as any other transfer — it never executes a transfer
directly.

**To go live:** requires `ANTHROPIC_API_KEY`, a real (non-placeholder) prompt
seeded via `apps/api/scripts/seed-prompt-template.js`, and
`ENABLE_AI_INTENT_DECODER=true`. Off by default until then.

### Cross-chain settlement (bridging) — Groundwork only

A `BridgeAdapter` interface with a Stellar-leg client built against the real
Allbridge Core SDK, verified live against its production quote API. Three
real constraints came out of that verification and shape what's left:

1. **Allbridge Core does not support Lisk** as a chain at all (confirmed
   against the SDK's own chain list). A working bridge needs either Allbridge
   adding Lisk, or a two-hop route: Lisk → Ethereum via Lisk's native
   OP-Stack canonical bridge → Ethereum → Stellar via Allbridge (Ethereum is
   supported). Neither hop is built yet.
2. **Allbridge Core has no testnet** — it's mainnet-only. Quoting is safe to
   run anywhere; actually moving funds through it is real mainnet activity,
   so no code path in this repo executes a real transfer automatically.
3. **Allbridge's Stellar-side USDC lives on Soroban**, not classic Stellar.
   SendAm's existing wallet flow is classic-Stellar (Horizon, trustlines) —
   landing bridged funds usably needs a further Soroban integration step.

This is intentionally a spike, not a feature — see the header comments in
`apps/api/src/services/chains/bridge.adapter.js` and
`apps/api/scripts/bridge-spike.js` for the full detail.

### Gas sponsorship (paymaster) — Client built, no relayer exists

A complete, real thin client (`apps/api/src/services/paymaster.service.js`)
for calling a privately-run gas-sponsorship relayer. No relayer is deployed
anywhere yet, so it always degrades gracefully and Lisk sends stay
self-funded, same as the plain multi-chain build above. Wiring in a real
relayer, once one exists, is a config change (`PAYMASTER_SERVICE_URL`), not
a code change.

### Deposit notifications & NGN price display — Built, not scheduled/wired

- `apps/api/scripts/notify-deposits.js` detects incoming deposits by diffing
  a wallet's balance against its last known value, and messages the user on
  WhatsApp. Needs an external cron (or `NOTIFY_POLL_ENABLED=true` on exactly
  one instance) to actually run anywhere.
- `apps/api/src/services/priceOracle.service.js` fetches a live USD/NGN
  rate — works out of the box, no API key required. Not yet wired into the
  `balance` reply (additive follow-up, not a blocker for anything else).

---

## Path to production (near-term, unblocks everything above)

- Deploy the backend to a persistent Node host (Render, Railway, Fly.io — not
  serverless, see the [README](README.md#deployment) for why).
- Provision managed MongoDB and set every required secret.
- Point the WhatsApp webhook at the deployed host.
- Seed a real AI prompt (if the intent decoder is wanted) and set
  `ENABLE_AI_INTENT_DECODER=true`.
- Schedule `notify-deposits.js`.
- Wire the price oracle into the `balance` reply.

## Stellar protocol depth

- Implement SEP-10 (web authentication) — gives per-user authentication to
  the REST wallet API, currently its main open security gap.
- Support at least one non-native Stellar asset (the seam,
  `resolveAsset()` in `apps/api/src/services/chains/stellar.adapter.js`, is
  already there — needs a real changeTrust flow before first receive).
- Explore a Soroban contract the product actually calls (e.g. on-chain
  transfer guardrails, or an escrowed confirm-within-10-minutes payment
  mirroring the existing WhatsApp confirm flow). A contract that exists but
  isn't invoked by the product doesn't count.
- Richer transaction receipts, anchor integrations for fiat on/off-ramps.

## Cross-chain (Lisk) depth

- Resolve the bridge's Lisk gap: either the two-hop route (Lisk → Ethereum →
  Stellar) or wait on Allbridge adding native Lisk support.
- Build the Soroban-side integration needed to make bridged USDC usable.
- Stand up a real gas-sponsorship relayer and wire the paymaster client to
  it.
- Move from Lisk Sepolia to Lisk mainnet with a vetted deployment, mirroring
  the same "not yet" caution already applied to Stellar mainnet.

## Security & production readiness

- Managed secret/key management (KMS/HSM) in place of a single static
  `ENCRYPTION_KEY`; support key rotation.
- Audit logging for sensitive actions (transfers, admin logins, wallet
  creation).
- Monitoring and alerting — error alerting on the API host, alerts on
  Horizon/RPC submission failures and webhook signature rejections.
- Replace the single shared admin password with per-admin accounts and
  roles.
- Compliance review (KYC/AML/custody) before any mainnet or real-money
  launch, on either chain.

## Test & robustness gaps

- Integration tests for the full webhook flow (inbound message → parse →
  confirm → transfer), with Horizon/RPC and WhatsApp mocked at the HTTP
  boundary. Current suite is unit-only.
- Transaction lifecycle tests: `tx_bad_seq` retry path, insufficient
  balance, unfunded destination, confirmation expiry — now across both
  chains.
- Idempotency tests: duplicate webhook delivery must not double-send.
- A CI coverage gate once integration tests exist.

## Feature ideas (not yet prioritized)

Ideas for future consideration, grouped by theme. None of these are
blockers for anything above — they're what comes after the foundation is
solid and deployed.

**Everyday utility**
- Airtime/data top-up and bill payment (electricity, DSTV/GOTV, water) from
  the crypto balance.
- WhatsApp interactive buttons/lists instead of typed-only commands.
- Recurring/scheduled sends.
- Payment requests / invoicing (`request <amount> from <name>`).
- Spending analytics / periodic WhatsApp statement summary.
- Transaction memo/notes on a payment.
- Shareable payment links for non-WhatsApp contacts.

**Accessibility**
- Voice-note command support (transcribe, then feed into the same intent
  decoder).
- Local language support (Pidgin, Yoruba, Igbo, Hausa).
- USSD / feature-phone channel — a fallback rail for users without a
  smartphone or data plan.

**Product depth**
- Micro-savings goals.
- Yield on idle stablecoin balance via a Soroban lending/liquidity
  contract — real differentiator, real smart-contract risk, don't rush.
- Naira-pegged stablecoin support, if one becomes available on Stellar or
  Lisk — avoids double FX conversion.
- QR scan-to-pay (scan a merchant/peer code to pre-fill a send).
- Family/shared wallet with approval controls.

**Growth / distribution**
- Merchant/business accounts with simple invoicing.
- Referral/agent network for offline cash-in/cash-out onboarding —
  operationally heavy (KYC, agent management, physical cash), but the
  biggest lever for reaching genuinely unbanked users.
- Referral rewards (lighter-weight invite-a-friend loop).

**Trust / production readiness**
- Account recovery flow beyond a lost phone number (PIN/passphrase or
  social recovery).
- Proactive fraud/anomaly alerts before executing unusual transactions.
- Tiered/progressive KYC — verified users unlock higher send limits.
- In-chat support escalation to a human agent thread.
