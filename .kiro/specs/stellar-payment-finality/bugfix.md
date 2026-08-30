# Bugfix Requirements Document

## Introduction

A submitted Stellar payment transaction is marked `success` and a receipt is
issued to the customer at the moment the Stellar SDK's `submitTransaction` call
returns, without waiting for the transaction to be ingested and confirmed by a
closed Horizon ledger. This means receipts and settlement status can be
reported on the basis of *submission acceptance* rather than *on-chain
finality*, exposing the service to premature settlement, false-positive
confirmations, and undetected expiry — all without a clearly defined policy
for pending, confirmed, failed, and expired state transitions backed by ledger
evidence.

The reconciler (`payment.reconciler.js`) does query Horizon for stale
`processing` / `pending` records, but the orchestrator bypasses that path
entirely for the normal flow: it writes `success` synchronously before the
reconciler ever runs, so the finality gap exists on every payment. Additionally,
there is no explicit handling for delayed Horizon ingestion, Horizon history
gaps (e.g. a 404 while the ledger is still propagating), or a defined expiry
window after which an unconfirmed transaction is conclusively failed.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a Stellar transaction is submitted and the SDK call returns a response,
    THEN the system immediately sets `transaction.status = 'success'` and issues
    a customer receipt, regardless of whether the transaction has been ingested
    into a closed ledger.

1.2 WHEN the Horizon submission endpoint returns a response envelope but the
    transaction has not yet propagated to a closed ledger, THEN the system
    reports the transaction as settled, creating a false-positive confirmation.

1.3 WHEN the Horizon `submitTransaction` call returns an uncertain outcome
    (timeout or connection loss), THEN the system surfaces an error to the
    caller but leaves the transaction in `processing` status with no defined
    path to ledger-backed resolution.

1.4 WHEN a submitted transaction is not ingested within the ledger sequence
    window (i.e. the transaction's `setTimeout` bound expires), THEN the system
    has no explicit policy to transition the transaction to `failed` or
    `expired` based on ledger evidence.

1.5 WHEN the reconciler queries Horizon for a stale transaction and receives a
    404 (transaction hash not yet visible), THEN the system treats the 404 as a
    terminal "not found" signal rather than a transient ingestion delay,
    potentially failing a valid in-flight transaction prematurely.

1.6 WHEN a `processing` or `pending` transaction ages past `staleAgeMs × 3`
    (currently 15 minutes) and no Horizon match is found, THEN the system marks
    it `failed` purely on elapsed time — without confirming the transaction's
    ledger sequence has expired or that Horizon definitively has no record.

### Expected Behavior (Correct)

2.1 WHEN a Stellar transaction envelope is accepted by the submission endpoint,
    THEN the system SHALL set `transaction.status = 'pending'` (not `success`)
    and SHALL NOT issue a customer receipt until ledger-backed finality is
    confirmed.

2.2 WHEN Horizon confirms a pending transaction's hash is present in a closed
    ledger and `successful = true`, THEN the system SHALL transition the
    transaction to `success` and SHALL issue the customer receipt at that point.

2.3 WHEN the Horizon submission call returns an uncertain outcome (timeout or
    connection loss), THEN the system SHALL set `transaction.status = 'pending'`
    and SHALL schedule it for reconciliation against Horizon using the
    pre-computed transaction hash, without resubmitting.

2.4 WHEN a pending transaction's ledger sequence window has demonstrably closed
    (Horizon confirms the hash is absent and the last-ledger sequence has
    passed), THEN the system SHALL transition the transaction to `expired` and
    SHALL NOT issue a receipt.

2.5 WHEN Horizon returns a 404 for a pending transaction's hash and the
    transaction's `setTimeout` window has not yet elapsed, THEN the system
    SHALL treat the result as a transient ingestion delay and SHALL retry
    confirmation on the next reconciliation cycle rather than failing
    immediately.

2.6 WHEN a pending transaction has exceeded a defined confirmation timeout
    (backed by ledger sequence expiry evidence, not wall-clock elapsed time
    alone), THEN the system SHALL transition the transaction to `failed` and
    SHALL record the reason as `ledger_sequence_expired` in transaction
    metadata.

2.7 WHEN the admin interface or API queries a transaction that is `pending`,
    THEN the system SHALL reflect `pending` status rather than reporting a
    prematurely settled state.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a transaction is already confirmed `success` (idempotency short-circuit
    path), THEN the system SHALL CONTINUE TO return the existing receipt without
    resubmitting or re-issuing a duplicate notification.

3.2 WHEN a `submitTransaction` call fails with a definitive Horizon error (e.g.
    `tx_bad_seq`, `op_no_trust`, `op_underfunded`), THEN the system SHALL
    CONTINUE TO mark the transaction `failed` immediately and surface the
    appropriate error message to the caller.

3.3 WHEN the reconciler processes a stale `processing` transaction that has a
    confirmed `txHash` on Horizon (`successful = true`), THEN the system SHALL
    CONTINUE TO transition it to `success` and record the explorer URL.

3.4 WHEN the orchestrator's `markTransactionFailed` path runs due to a
    definitive submission error, THEN the system SHALL CONTINUE TO set
    `transaction.status = 'failed'` and log the error in transaction metadata
    without surfacing the bookkeeping error to the caller.

3.5 WHEN the admin refund flow checks that a transaction has `status = 'success'`
    before allowing a refund, THEN the system SHALL CONTINUE TO reject refunds
    for transactions that are `pending`, `processing`, `failed`, or `expired`.

3.6 WHEN the deposit poller detects an inbound payment for a wallet, THEN the
    system SHALL CONTINUE TO notify the wallet owner without depending on or
    altering outbound payment finality logic.

3.7 WHEN a payment is submitted with a valid idempotency key and a prior
    `pending` record exists, THEN the system SHALL CONTINUE TO return the
    existing pending transaction without creating a duplicate submission.
