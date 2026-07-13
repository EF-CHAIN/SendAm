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
- Transactions can carry a **memo** (useful later for payment references).

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

## Ecosystem terms you'll see in discussions

- **Anchor** — a regulated business bridging Stellar assets and bank money
  (deposit naira → receive tokens, and back). The future cash-out leg.
- **SEPs** — Stellar Ecosystem Proposals, interop standards. Ones relevant
  to the roadmap: SEP-10 (auth), SEP-24/31 (anchor deposit/withdraw),
  SEP-2 (federated addresses like `ada*sendam.app`).
- **Explorer** — receipts link to [stellar.expert](https://stellar.expert);
  paste any tx hash or account there while debugging.

## Further reading

- [Stellar developer docs](https://developers.stellar.org/docs)
- [JS SDK](https://stellar.github.io/js-stellar-sdk/) (`@stellar/stellar-sdk`)
- [Stellar Laboratory](https://laboratory.stellar.org) — build/inspect
  transactions by hand on testnet; the fastest way to learn the ledger
