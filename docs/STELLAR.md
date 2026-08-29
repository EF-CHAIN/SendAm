# Stellar primer for SendAm contributors

You can contribute to most of SendAm knowing zero blockchain. This page is
the minimum Stellar knowledge for touching the wallet/payment path, mapped
to where each concept lives in the code.

## Accounts and keys

A Stellar account is a keypair:

- **Public key** — `G...`, 56 characters. This is the address you share.
- **Secret key** — `S...`. Signs transactions. In SendAm it is generated in
  `stellar.adapter.js`, encrypted with AES-256-GCM (`crypto.service.js`),
  and only ever decrypted inside `wallet.service.js` for the moment of
  signing. Plaintext secrets never leave that file — keep it that way.

An account **does not exist** on the network until it holds the minimum XLM
balance (see reserves). Sending to a `G...` address that was never funded
fails with "Destination account does not exist" — that's why
`stellar.adapter.js` checks `loadAccount(destination)` before paying.

## Reserves (why accounts need XLM)

Stellar requires every account to hold a **base reserve** (currently 0.5 XLM
per entry, 1 XLM minimum for the account itself). Each additional entry —
like a trustline — adds to the requirement. Practical consequences:

- A brand-new wallet can't do anything until someone deposits XLM into it.
- On **testnet**, [Friendbot](https://friendbot.stellar.org) funds any
  account with 10,000 test XLM — `fundTestnetAccount()` in the adapter
  wraps it with retries.
- On **mainnet** there is no Friendbot. New wallets need real XLM deposited
  before they can do anything — see the [ROADMAP](../ROADMAP.md) for the
  path to production.

## Assets and trustlines

XLM is the native asset; everything else (USDC, NGN tokens) is an **issued
asset** identified by `code + issuer address`. Before an account can hold an
issued asset it must open a **trustline** to it (a `changeTrust` operation),
which costs one reserve entry.

Consequences you'll hit in code:

- `resolveAsset()` in `stellar.adapter.js` maps an asset code to the SDK
  object — this is the seam where USDC support lands.
- Paying USDC to an account with no USDC trustline fails with `op_no_trust`.
  User-facing code must translate that to a human sentence.
- Same asset code from a different issuer is a **different asset**. Issuer
  addresses live in config, never hardcoded.

## Transactions, sequence numbers, fees

- Every transaction is built against the source account's **sequence
  number**. Two concurrent sends from one account race; the loser fails with
  `tx_bad_seq`. The adapter already retries that case — read the comment
  above `isBadSequence()` before touching submission logic.
- Fees are tiny (100 stroops base = 0.00001 XLM) but nonzero, paid in XLM by
  the source account. *Fee-bump transactions* let a different account pay
  the fee, if that's ever needed.
- Transactions can carry a **memo** (useful for payment references and exchange deposit routing).

## Memos and Muxed Accounts (SEP-23 & SEP-30)

Stellar payments can specify destination routing via Memos or Muxed Addresses:

- **Supported Memo Types**: `text` (max 28 bytes UTF-8), `id` (unsigned 64-bit integer string), `hash` (32-byte hex/buffer), `return` (32-byte hex/buffer).
- **Muxed Accounts (`M...`)**: SEP-23 Muxed addresses embed a 64-bit subaccount ID into a 69-character address (`M...`). SendAm resolves the underlying classic `G...` key for Horizon account verification while keeping the `M...` address for payment operation destination.
- **Conflicting Combination Rule**: Providing both a Muxed destination (`M...`) AND an explicit separate memo is **conflicting** and will be rejected prior to transaction construction.
- **Redaction**: Memos containing sensitive identifiers are masked (`ab***ef`) in user-facing receipts, logs, and audit records.

## Horizon (the API you actually call)

Nodes speak SCP; apps speak to **Horizon**, a REST API over the ledger.
SendAm's Horizon URL is `STELLAR_HORIZON_URL` in config
(testnet default: `https://horizon-testnet.stellar.org`).

Endpoints you'll meet in this codebase:

- `GET /accounts/{id}` — balances, sequence, trustlines (`loadAccount`)
- `POST /transactions` — submit a signed transaction
- `GET /accounts/{id}/payments?cursor=` — payment history; **cursor-paginated**,
  which is exactly how the deposit poller tracks "what's new" per wallet

Horizon error responses carry `extras.result_codes` — that's where
`op_no_trust`, `op_underfunded`, `tx_bad_seq` live.

## Funding-account health and operator runbook

SendAm now measures the live funding account's base fee, native XLM balance, and projected reserve pressure before wallet creation or payouts block. The monitor is implemented in `stellar.adapter.js` via `getFundingAccountHealth()` and reads thresholds from `config.stellar.thresholds`.

Recommended defaults:

- Base fee warning: 200 stroops, critical: 250 stroops
- Funding balance warning: 20 XLM, critical: 10 XLM
- Reserve usage warning: 70%, critical: 85%

A healthy funding account should have:

- `status === 'ok'`
- `reserveStatus` below warning threshold
- enough free XLM to cover at least one future reserve cycle for new customer wallets

If the monitor raises a warning or critical alert, use this runbook:

1. Top up the configured funding account before funding more wallets.
2. Check the current Horizon base fee; if it is near or above the critical threshold, slow batch payouts and fund the account immediately.
3. Review reserve stress: if projected reserve consumption exceeds the warning threshold, pause wallet creation and trustline setup until the balance recovers.
4. Confirm the operator alert is tied to a real account and not a temporary network spike before redeploying traffic.

This gives operators a single signal to act on instead of discovering failed wallet creation after the fact.

## Testnet vs mainnet

| | Testnet | Mainnet |
|---|---|---|
| Money | Fake | Real |
| Funding | Friendbot | Real XLM / sponsored reserves |
| Network passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| Resets | Periodically wiped by SDF | Never |

The passphrase is part of every signature — sign with the wrong one and the
transaction is invalid. `config.stellar.network` drives the choice; never
hardcode it. **All development happens on testnet. PRs that touch mainnet
behavior get extra scrutiny.**

### Mainnet safety controls

The codebase enforces several safety controls when `STELLAR_NETWORK` is set
to `public` (or any value other than `testnet`):

1. **Friendbot blocked** — `fundTestnetAccount()` in `stellar.adapter.js`
   immediately throws if `config.stellar.isMainnet` is `true`. This prevents
   accidental testnet funding calls from reaching mainnet.

2. **USDC issuer validation** — `validateEnv()` rejects startup if the
   configured `STELLAR_USDC_ISSUER` is the Testnet issuer address while
   running on mainnet. This catches misconfigured `.env` files before any
   transactions can execute.

3. **Horizon URL** — defaults to `https://horizon-testnet.stellar.org` for
   testnet. Mainnet deployments must explicitly set `STELLAR_HORIZON_URL`
   to a public Horizon instance (e.g. `https://horizon.stellar.org`).

### Environment variables for mainnet

| Variable | Testnet default | Mainnet requirement |
|---|---|---|
| `STELLAR_NETWORK` | `testnet` | `public` |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` | Must be set to a public Horizon URL |
| `STELLAR_USDC_ISSUER` | Testnet issuer | Must be Circle's mainnet issuer: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |

### Rollback

If a mainnet deployment needs to be rolled back:

1. Set `STELLAR_NETWORK=testnet` to disable mainnet controls.
2. Revert to testnet Horizon URL and USDC issuer.
3. All pending mainnet transactions remain on-ledger; rollback only affects
   future operations.

### Operational notes

- **Idempotency**: `fundTestnetAccount` treats "account already exists" as
  success. `establishTrustline` is a no-op if the trustline already exists.
  Retries are safe for all financial operations.
- **Partial failures**: Payment submission retries only on `tx_bad_seq`
  (concurrent transaction conflict). All other failures are terminal and
  surfaced with human-readable messages.

## Ecosystem terms you'll see in discussions

- **Anchor** — a regulated business bridging Stellar assets and bank money
  (deposit naira → receive tokens, and back). The future cash-out leg.
- **SEPs** — Stellar Ecosystem Proposals, interop standards. Ones relevant
  to the roadmap: SEP-10 (auth), SEP-24/31 (anchor deposit/withdraw),
  SEP-2 (federated addresses like `ada*sendam.app`).
- **Explorer** — receipts link to [stellar.expert](https://stellar.expert);
  paste any tx hash or account there while debugging.

## SEP-10 REST authentication

REST clients authenticate ownership of a Stellar account; they never establish
identity with a phone number. WhatsApp remains a separate trusted path: Meta's
webhook signature authenticates the transport and the verified sender number is
the customer identity. A REST session cannot select or override that identity.

1. `GET /api/auth/challenge?account=G...` returns a short-lived SEP-10 challenge.
2. The wallet signs it and posts the XDR as `transaction` to `/api/auth/token`.
3. The response is a random, 15-minute bearer token; only its hash is stored.
4. Use it for wallet, PIN, and KYC routes. `/api/auth/logout` revokes it.

Challenges are consumed atomically. Expired, replayed, malformed, wrong-signer,
wrong-domain, and wrong-network challenges fail. Auth endpoints allow 10 attempts
per IP per minute, and important outcomes are recorded in `AuditLog`.

### Configuration, rollout, and recovery

Use a dedicated unfunded key for `STELLAR_AUTH_SIGNING_KEY`. Set
`STELLAR_HOME_DOMAIN` to the domain publishing `stellar.toml` and
`STELLAR_WEB_AUTH_DOMAIN` to the exact API host; its `WEB_AUTH_ENDPOINT` and
`SIGNING_KEY` must agree. Optional limits are
`STELLAR_AUTH_CHALLENGE_TTL_SECONDS` (30-900) and `REST_SESSION_TTL_MINUTES`
(1-60). Deploy the database migration and domain configuration before enabling
`ENABLE_WALLET_REST_API`. The flag is an operational kill switch, not auth.

Monitor `auth.verification.failed` audit events by IP and reason, HTTP 401/429
rates, and session creation volume. During an incident, disable the REST flag
and revoke active sessions with
`UPDATE "RestSession" SET "revokedAt" = NOW() WHERE "revokedAt" IS NULL`.
Rotate the signing key and `stellar.toml` together. Rotation invalidates open
challenges; revoke sessions explicitly if compromise is suspected.

## Further reading

- [Stellar developer docs](https://developers.stellar.org/docs)
- [JS SDK](https://stellar.github.io/js-stellar-sdk/) (`@stellar/stellar-sdk`)
- [Stellar Laboratory](https://laboratory.stellar.org) — build/inspect
  transactions by hand on testnet; the fastest way to learn the ledger
