# Changelog

All notable changes to SendAm are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Secret scanning with gitleaks: CI workflow (`.github/workflows/secret-scan.yml`),
  custom ruleset (`.gitleaks.toml`) covering Stellar keys, provider tokens,
  database URLs, and generic high-entropy secrets. Self-test validates the
  scanner catches seeded fakes on every run. Local script
  (`scripts/secret-scan-self-test.sh`) for pre-push verification. See
  `docs/SECRET-SCANNING.md` for false-positive review and credential-rotation
  response.
- Code of Conduct (Contributor Covenant 2.1).
- Payment submission retry on Stellar `tx_bad_seq` to handle concurrent sends
  from the same account.
- Unit tests for transfer guardrails, recipient resolution, and request
  validators.
- USDC trustline support: `stellar.adapter.js` now exposes `getBalances()`,
  `resolveAsset('USDC')`, and `establishTrustline()`. `wallet.service.js`
  automatically opens the USDC trustline at wallet creation and on every
  `fundWallet` retry. Tests: `balance.multiasset.test.js`,
  `wallet.trustline.test.js`.
- SEP-10 REST authentication: challenge/token service in
  `services/restAuth.service.js` lets REST clients prove Stellar account
  ownership before accessing wallet, PIN, and KYC routes.
- Integration test suite: `webhook.integration.test.js`,
  `restAuthRoutes.integration.test.js`, `restProtectedRoutes.integration.test.js`,
  `deposits.jobs.test.js`, `seed.idempotency.test.js` — webhook flow, auth
  routes, protected routes, deposit polling, and idempotency under duplicate
  delivery are now tested end-to-end (mocked Horizon / WhatsApp boundaries).
- `apps/chat-sim` — WhatsApp chat simulator for local end-to-end development
  without requiring a live Meta webhook.
- Observability: Prometheus metrics, correlated JSON logs, and external
  exception delivery (see `docs/OBSERVABILITY.md`).
- Background worker split: `npm run start:worker` runs BullMQ processors and
  pollers separately from the HTTP API process (see `docs/BACKGROUND-WORKERS.md`).
- `ISSUE_CLOSURE_CHECKLIST.md` — reusable closure/release checklist requiring
  acceptance-criteria evidence for PRs and releases.
- Redis availability and recovery safeguards: a single shared connection policy
  in `apps/api/src/config/redis.js` (TLS from `rediss://` / `REDIS_CA` /
  `REDIS_TLS`, exponential bounded reconnect backoff, connect/command timeouts,
  keep-alive, and Sentinel topology for automatic failover). All Redis consumers
  (BullMQ queues, the WhatsApp DLQ, and per-sender ordering) now share one
  connection so an outage surfaces as consistent metrics/alerts instead of
  silently dropping accepted work. Disconnect, reconnect, failover, and recovery
  transitions emit Prometheus metrics and operator logs, and an inline fallback
  path is explicitly alarmed rather than silent. Tests:
  `apps/api/test/redis.safeguards.test.js`.

### Changed

- HTTP request logging now uses the `combined` Morgan format in production
  (`dev` elsewhere) for production-grade access logs.
- The REST `POST /api/wallet/create` endpoint now marks the wallet as funded on
  successful Friendbot funding, matching the WhatsApp flow.
- Documentation audited for correctness against `main`:
  - All "Mongo-backed rate limiting" references corrected to "PostgreSQL-backed".
  - "Unit-only test suite" claim corrected; integration tests now documented.
  - "XLM only / no anchor-asset support" claim corrected; USDC is built.
  - Repository comparison links corrected to `EF-CHAIN/SendAm`.
  - Monorepo structure updated to include `apps/chat-sim`.
  - ROADMAP status vocabulary extended with `Configured` and `Approved` stages.

## [1.0.0]

### Added

- WhatsApp-first wallet experience: `create wallet`, `fund`, `balance`,
  `save <alias> <key>`, `contacts`, `send <amount> xlm <recipient>`, and
  `yes`/`no` confirmation flow.
- Stellar Testnet wallet creation with Friendbot funding (retry with backoff and
  a `fund` recovery command).
- Native XLM balance checks and payments through Horizon, with Stellar Expert
  receipt links stored for auditability.
- Saved recipient aliases for repeat payments.
- Confirmation-based transfers with an upfront balance check and a 10-minute
  pending-transfer expiry.
- Admin dashboard (Vite + React) for users, wallets, and transactions, with
  server-side pagination.
- REST API for wallet creation, balance, and transfers (unauthenticated;
  disabled in production by default via `ENABLE_WALLET_REST_API`).

### Security

- Authenticated AES-256-GCM encryption of wallet secrets; no fallback key
  (fails fast at startup if `ENCRYPTION_KEY` is missing or invalid).
- Admin authentication via HMAC-signed, expiring session tokens; the API refuses
  to start without `ADMIN_PASSWORD` and `JWT_SECRET`.
- WhatsApp webhook signature verification against `X-Hub-Signature-256`
  (fail-closed in production).
- Inbound message idempotency to prevent duplicate transfers from webhook
  retries.
- Per-user transfer guardrails: per-transaction cap plus rolling 24h amount and
  count limits.
- CORS allowlist enforced in production and PostgreSQL-backed rate limiting
  shared across instances (per-IP REST, per-sender WhatsApp).

### Operations

- `GET /health` readiness probe (503 when the database link is down).
- Graceful shutdown that drains in-flight requests before exit.
- Continuous integration: backend tests plus frontend lint and build on every
  pull request.

[Unreleased]: https://github.com/EF-CHAIN/SendAm/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/EF-CHAIN/SendAm/releases/tag/v1.0.0
