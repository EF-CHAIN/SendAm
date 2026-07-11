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

### Core platform — Built, deployment in progress

WhatsApp-driven payment orchestration on Postgres/Prisma: direct-custody
wallets (a Stellar and a Lisk wallet per user, keys generated and encrypted
locally — see [`ARCHITECTURE.md`](ARCHITECTURE.md)), Lisk as the primary
settlement rail with Stellar for cross-border corridors, escrow, KYC tiers
with PIN verification, admin dashboard (users, wallets, transactions,
escrows, KYC, audit logs, system health), and BullMQ-based background
processing for webhook/voice/receipt jobs.

### Multi-chain foundation (Lisk) — Built, deployment in progress

- Chain-adapter pattern (`apps/api/src/wallet/`): Stellar and Lisk behind
  one interface, product code never imports a chain SDK directly.
- Every user gets a Stellar **and** a Lisk wallet — no "pick a chain" step.
  `balance` reports both chains; a plain send detects the destination chain
  from address shape and routes automatically.
- Known gap, not hidden: Lisk Sepolia (testnet) has no Friendbot-equivalent
  auto-fund API. New Lisk wallets are created but not auto-funded — the bot
  gives manual faucet instructions instead of pretending funding happened.
- Native assets only for now (XLM, native Lisk ETH) — no ERC-20/anchor-asset
  support yet (the seam for it is `resolveAsset()` in each adapter).

### Gas sponsorship (paymaster) — Client built, no relayer exists

A complete, real thin client (`apps/api/src/services/paymaster.service.js`)
for calling a privately-run gas-sponsorship relayer. No relayer is deployed
anywhere yet, so it always degrades gracefully and Lisk sends stay
self-funded. Not yet wired into the live send flow. Wiring in a real
relayer, once one exists, is a config change (`PAYMASTER_SERVICE_URL`), not
a code change.

### NGN price display — Built, not wired into a reply

`apps/api/src/services/priceOracle.service.js` fetches a live USD/NGN
rate — works out of the box, no API key required. Not yet wired into any
WhatsApp reply (additive follow-up, not a blocker for anything else).

### Explored but not merged

A parallel line of work also explored AI-assisted WhatsApp command parsing
as a fallback to the regex parser, a cross-chain bridging groundwork spike
(Stellar leg via Allbridge Core), and a deposit-notification poller. None of
that is part of this codebase — that work depended on the MongoDB
persistence layer this repo no longer uses. It's preserved in git history on
the `feat/multi-chain-foundation` branch (tip commit `d770f2c`) if any of it
is worth re-implementing against the current Postgres/Prisma base later —
the AI intent decoder and deposit-notification concepts are still plausible
additions, just not as originally built.

---

## Path to production (near-term, unblocks everything above)

- Deploy the backend to a persistent Node host (Render, Railway, Fly.io — not
  serverless, see the [README](README.md#deployment) for why).
- Apply the Prisma migration to a provisioned Neon database.
- Point the WhatsApp webhook at the deployed host.
- Configure a real Lisk RPC endpoint (`LISK_RPC_URL`) for mainnet or a less
  rate-limited testnet provider.
- Wire the price oracle into a WhatsApp reply.

## Security & production readiness

- Build real per-user authentication for the compliance PIN and KYC-start
  REST endpoints (see [README](README.md#security-notes)) — the biggest open
  gap right now.
- Managed secret/key management (KMS/HSM) in place of a single static
  `ENCRYPTION_KEY` for wallet private keys; support key rotation.
- Audit logging for sensitive actions (transfers, admin logins, compliance
  reviews) — audit log model exists, coverage isn't complete yet.
- Monitoring and alerting — error alerting on the API host, alerts on
  Horizon/RPC submission failures, KYC provider failures, and webhook
  signature rejections.
- Replace the single shared admin password with per-admin accounts and
  roles.
- Compliance review (KYC/AML/custody) before any mainnet or real-money
  launch.

## Chain depth

- Support at least one non-native asset per chain (Stellar assets via
  `changeTrust`, Lisk ERC-20/bridged USDC) — the seam, `resolveAsset()` in
  each adapter, is already there.
- Implement SEP-10 (Stellar web authentication) — would give per-user
  authentication to the REST wallet API, currently its main open security
  gap alongside the compliance PIN/KYC-start endpoints.
- Move from Lisk Sepolia to Lisk mainnet, and Stellar Testnet to mainnet,
  with a vetted deployment for each.

## Test & robustness gaps

- Integration tests for the full webhook flow (inbound message → parse →
  confirm → transfer), with the wallet provider and WhatsApp mocked at the
  HTTP boundary. Current suite is unit-only.
- Tests for the payment orchestrator, escrow lifecycle, and compliance
  policy enforcement (tier limits, risk scoring).
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
- Voice-note command support beyond the existing transcription pipeline.
- Local language support (Pidgin, Yoruba, Igbo, Hausa).
- USSD / feature-phone channel — a fallback rail for users without a
  smartphone or data plan.

**Product depth**
- Micro-savings goals.
- Yield on idle stablecoin balance — real differentiator, real
  smart-contract risk, don't rush.
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
