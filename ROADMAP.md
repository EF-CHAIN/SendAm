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
Stellar wallets (one per user, keys generated and encrypted locally — see
[`ARCHITECTURE.md`](ARCHITECTURE.md)), Stellar as the settlement rail, KYC
tiers with PIN verification, admin dashboard (users, wallets, transactions,
KYC, audit logs, system health), and BullMQ-based background
processing for webhook/voice/receipt jobs.

### Stellar-only refocus — Done

An earlier iteration ran a second chain (Lisk) behind a chain-registry
abstraction with automatic rail selection. That was removed deliberately:
a second chain doubled the custody, audit, and asset-support surface
without adding user value. The codebase is now flattened to a single
Stellar adapter; the multi-chain history is preserved in git.

- Native asset only for now (XLM) — no anchor-asset support yet (the seam
  for it is `resolveAsset()` in the adapter).

---

## Path to production (near-term, unblocks everything above)

- Deploy the backend to a persistent Node host (Render, Railway, Fly.io — not
  serverless, see the [README](README.md#deployment) for why).
- Apply the Prisma migration to a provisioned Neon database.
- Point the WhatsApp webhook at the deployed host.

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

- Support at least one non-native Stellar asset via `changeTrust` (USDC,
  anchor-issued assets) — the seam, `resolveAsset()` in the adapter, is
  already there.
- Implement SEP-10 (Stellar web authentication) — would give per-user
  authentication to the REST wallet API, currently its main open security
  gap alongside the compliance PIN/KYC-start endpoints.
- Move from Stellar Testnet to mainnet with a vetted deployment.

## Test & robustness gaps

- Integration tests for the full webhook flow (inbound message → parse →
  confirm → transfer), with the wallet provider and WhatsApp mocked at the
  HTTP boundary. Current suite is unit-only.
- Tests for the payment orchestrator and compliance
  policy enforcement (tier limits, risk scoring).
- Idempotency tests: duplicate webhook delivery must not double-send.
- A CI coverage gate once integration tests exist.