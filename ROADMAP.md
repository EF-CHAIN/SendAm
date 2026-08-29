# Roadmap

This is the detailed, public roadmap for SendAm. For the "why" behind the
architecture referenced below, see [`ARCHITECTURE.md`](ARCHITECTURE.md). The
top-level [`README.md`](README.md) keeps a short summary; this file is the
full picture, kept current as work lands.

## Status vocabulary

Every item below is tagged with one of the following statuses. These are
distinct states — an item cannot advance to a later stage without the earlier
ones being true.

| Status | Meaning |
|--------|---------|
| **Built** | Code exists in this repo and is covered by automated tests. |
| **Configured** | Built, and all required environment / provider credentials are in place in production. |
| **Deployed** | Configured, and actually running on a reachable host handling real traffic. |
| **Approved** | Deployed, and any required legal, compliance, KYC/AML, or regulatory review has been completed for real-money operation. |
| **Planned** | Not started yet. |

Built is not the same as live. A feature can be fully built and still not do
anything for a real user until it is configured, deployed, and approved — that
gap is called out explicitly wherever it applies.

---

## Where things stand today

### Core platform — Built, deployment in progress

WhatsApp-driven payment orchestration on Postgres/Prisma: direct-custody
Stellar wallets (one per user, keys generated and encrypted locally — see
[`ARCHITECTURE.md`](ARCHITECTURE.md)), Stellar as the settlement rail, KYC
tiers with PIN verification, admin dashboard (users, wallets, transactions,
KYC, audit logs, system health), and BullMQ-based background processing for
webhook/voice/receipt jobs.

Code evidence:
- Stellar adapter: [`apps/api/src/wallet/stellar.adapter.js`](apps/api/src/wallet/stellar.adapter.js)
- Wallet service: [`apps/api/src/wallet/wallet.service.js`](apps/api/src/wallet/wallet.service.js)
- Payment orchestrator: [`apps/api/src/payment/payment.orchestrator.js`](apps/api/src/payment/payment.orchestrator.js)
- Compliance service: [`apps/api/src/compliance/compliance.service.js`](apps/api/src/compliance/compliance.service.js)
- BullMQ queues: [`apps/api/src/queues/queue.service.js`](apps/api/src/queues/queue.service.js)

### Stellar-only refocus — Done

An earlier iteration ran a second chain (Lisk) behind a chain-registry
abstraction with automatic rail selection. That was removed deliberately:
a second chain doubled the custody, audit, and asset-support surface
without adding user value. The codebase is now flattened to a single
Stellar adapter; the multi-chain history is preserved in git.

### USDC / non-native asset support — Built

XLM (native) and USDC are both supported:

- `resolveAsset('USDC')` in [`stellar.adapter.js`](apps/api/src/wallet/stellar.adapter.js) maps to the configured issuer via `STELLAR_USDC_ISSUER`.
- `getBalances()` returns per-asset rows covering XLM and any USDC trustline held by the account.
- `establishTrustline({ assetCode: 'USDC' })` opens the `changeTrust` operation.
- [`wallet.service.js`](apps/api/src/wallet/wallet.service.js) automatically opens the USDC trustline at wallet creation and on every `fundWallet` retry — wallets can receive USDC from day one.
- Tests: [`apps/api/test/balance.multiasset.test.js`](apps/api/test/balance.multiasset.test.js), [`apps/api/test/wallet.trustline.test.js`](apps/api/test/wallet.trustline.test.js).

`resolveAsset()` is the seam for adding further anchor-issued assets; a new code + issuer pair is the only change required.

### SEP-10 REST authentication — Built

Wallet-ownership authentication for REST clients is in place:

- Challenge/token service: [`apps/api/src/services/restAuth.service.js`](apps/api/src/services/restAuth.service.js)
- Route integration tests: [`apps/api/test/restAuthRoutes.integration.test.js`](apps/api/test/restAuthRoutes.integration.test.js), [`apps/api/test/restProtectedRoutes.integration.test.js`](apps/api/test/restProtectedRoutes.integration.test.js)

REST sessions are independent from WhatsApp identity (Meta webhook signature). Enabling the authenticated REST surface requires deploying with `ENABLE_WALLET_REST_API=true` and the `STELLAR_AUTH_SIGNING_KEY` / domain variables — see [`docs/STELLAR.md`](docs/STELLAR.md#sep-10-rest-authentication).

### PostgreSQL-backed rate limiting — Built

Per-IP REST rate limiting and per-sender WhatsApp throttling share a single fixed-window counter table in PostgreSQL, so limits are enforced uniformly across all API instances.

- Store: [`apps/api/src/middlewares/postgresRateStore.js`](apps/api/src/middlewares/postgresRateStore.js)
- Service: [`apps/api/src/services/rateLimit.service.js`](apps/api/src/services/rateLimit.service.js)

---

## Path to production (near-term, unblocks everything above)

- Deploy the backend to a persistent Node host (Render, Railway, Fly.io — not
  serverless, see the [README](README.md#deployment) for why).
- Apply the Prisma migration to a provisioned Neon database.
- Point the WhatsApp webhook at the deployed host.

## Security & production readiness

- **Build real per-user authentication for the compliance PIN and KYC-start
  REST endpoints** — the biggest open gap right now. (See [README](README.md#security-notes).)
- **Managed secret/key management** (KMS/HSM) in place of a single static
  `ENCRYPTION_KEY` for wallet private keys; support key rotation.
- **Audit logging coverage** — the audit log model exists and wallet/payment
  events are written; coverage for admin and compliance actions is not complete.
- **Monitoring and alerting** — error alerting on the API host, alerts on
  Horizon/RPC submission failures, KYC provider failures, and webhook signature
  rejections. See [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) for the
  Prometheus / alerting setup already defined.
- **Per-admin accounts and roles** — replace the single shared admin password.
- **Compliance review** (KYC/AML/custody) before any mainnet or real-money launch.
- Add explicit sanctions and custody workflow requirements for deployment,
  including blocked/high-risk country screening, manual review state, and
  audit-visible compliance decisions.

## Test coverage

The test suite uses Node's built-in `node:test` runner (no extra test framework
dependency) and covers unit and integration scenarios across the backend.

Built tests include:

| Test file | Scope |
|-----------|-------|
| [`crypto.test.js`](apps/api/test/crypto.test.js) | Wallet key encryption/decryption |
| [`adminAuth.test.js`](apps/api/test/adminAuth.test.js) | HMAC session token generation and verification |
| [`validators.test.js`](apps/api/test/validators.test.js) | Input validation helpers |
| [`stellarAdapter.test.js`](apps/api/test/stellarAdapter.test.js) | Stellar adapter unit tests |
| [`balance.multiasset.test.js`](apps/api/test/balance.multiasset.test.js) | Multi-asset (XLM + USDC) balance reply |
| [`wallet.trustline.test.js`](apps/api/test/wallet.trustline.test.js) | USDC trustline open at creation and on fund retry |
| [`webhook.integration.test.js`](apps/api/test/webhook.integration.test.js) | Full webhook flow with mocked Prisma and adapter |
| [`restAuthRoutes.integration.test.js`](apps/api/test/restAuthRoutes.integration.test.js) | SEP-10 challenge/token endpoints |
| [`restProtectedRoutes.integration.test.js`](apps/api/test/restProtectedRoutes.integration.test.js) | Authenticated REST route enforcement |
| [`deposits.jobs.test.js`](apps/api/test/deposits.jobs.test.js) | Deposit polling background job |
| [`seed.idempotency.test.js`](apps/api/test/seed.idempotency.test.js) | Idempotency under duplicate webhook delivery |
| [`payment.orchestrator.test.js`](apps/api/test/payment.orchestrator.test.js) | Payment orchestration logic |
| [`compliance.service.test.js`](apps/api/test/compliance.service.test.js) | KYC tiers, limits, risk scoring |
| [`kyc.lifecycle.test.js`](apps/api/test/kyc.lifecycle.test.js) | KYC status transitions |

Remaining gaps (Planned):

- Tests for orchestrator + compliance interaction under real-money scenarios.
- A CI coverage gate once all integration tests are in stable shape.

## Chain depth

- ~~Support at least one non-native Stellar asset via `changeTrust` (USDC,
  anchor-issued assets)~~ — **Done.** See USDC section above.
- **Implement SEP-10 (Stellar web authentication)** — Built. Needs deployment configuration.
- **Move from Stellar Testnet to mainnet** with a vetted deployment — Planned.

## Open issues

- #152 — This roadmap update (documentation audit and release-readiness).
