# Provider contract / sandbox tests

These tests check application assumptions against Meta, Stellar, Smile ID, and pricing sandboxes.

## Two modes

- **Hermetic** — always on PR CI; no secrets (fixtures only). Example: Meta webhook signature.
- **Credentialed** — only with sandbox env vars; never production. Examples: Smile ID, ExchangeRate.
- **Stellar** — public testnet Horizon, read-only, no keys.

## Run

From repo root:

    npm test --workspace=apps/api

Only contract suite:

    node --test apps/api/test/contract/**/*.test.js

## Skip safely

Credentialed tests call skipUnlessCredentials(...).
If env vars are missing, the test is skipped (not failed).

Optional env:

- SMILE_ID_API_KEY
- SMILE_ID_PARTNER_ID
- SMILE_ID_BASE_URL (optional)
- EXCHANGE_RATE_API_KEY
- EXCHANGE_RATE_BASE_URL (optional)

Do not put production WhatsApp, mainnet Stellar keys, or live Smile production credentials in CI.

## Failure triage

- Hermetic Meta failure → signature or payload shape drift.
- Horizon skip/fail → network or Horizon outage; re-run.
- Smile / pricing skip → missing sandbox env (expected on public PRs).
- Smile / pricing assert fail → provider API drift; update client or fixture.

Logs use redaction helpers so secrets and phone numbers do not appear in CI artifacts.
