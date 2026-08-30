# Wallet provisioning recovery

Wallet creation, testnet funding, and USDC trustline setup are separate durable stages. `fundingState` and `trustlineState` use `pending`, `in_progress`, `succeeded`, or `failed` (`blocked` is also used for migrated unfunded wallets). Attempts, the last safe error message, and stage timestamps are stored on `Wallet` and visible through the administrator wallet endpoint.

An API retry claims only pending or failed work. An `in_progress` claim becomes recoverable after five minutes so a terminated worker cannot strand provisioning indefinitely. Friendbot's already-funded response and Stellar trustline establishment are treated idempotently by the adapter.

To recover a failed wallet, inspect its state and error in the admin wallet list, correct the provider or network problem, then repeat the customer's create-or-get request or invoke the existing funding workflow. Do not edit encrypted key material or reset a succeeded stage. Repeated failures create `wallet.funding.failed` or `wallet.trustline.failed` audit events with `retryable: true`.

The PostgreSQL concurrency test requires an isolated migrated database:

```sh
TEST_DATABASE_URL=postgresql://... node --test apps/api/test/wallet.concurrency.postgres.test.js
```
