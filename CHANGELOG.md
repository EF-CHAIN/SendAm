# Changelog

All notable changes to SendAm are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Code of Conduct (Contributor Covenant 2.1).
- Payment submission retry on Stellar `tx_bad_seq` to handle concurrent sends
  from the same account.
- Unit tests for transfer guardrails, recipient resolution, and request
  validators.

### Changed

- HTTP request logging now uses the `combined` Morgan format in production
  (`dev` elsewhere) for production-grade access logs.
- The REST `POST /api/wallet/create` endpoint now marks the wallet as funded on
  successful Friendbot funding, matching the WhatsApp flow.

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
- CORS allowlist enforced in production and Mongo-backed rate limiting shared
  across instances.

### Operations

- `GET /health` readiness probe (503 when the database link is down).
- Graceful shutdown that drains in-flight requests before exit.
- Continuous integration: backend tests plus frontend lint and build on every
  pull request.

[Unreleased]: https://github.com/Gozirimdev/SendAm/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Gozirimdev/SendAm/releases/tag/v1.0.0
