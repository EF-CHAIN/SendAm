## PR Title
fix(wallet): make Stellar transaction submission idempotent across timeouts (#197)

## What
Refactors `stellar.adapter.js` to persist the transaction hash before submission, re-using the same envelope on ambiguous timeouts, and checking Horizon before retries to prevent duplicate payments.

## Why
Closes #197

## How
- **apps/api/src/wallet/stellar.adapter.js**: Lifted `transaction` and `hash` generation outside the retry loop. Retries now reuse the exact same signed envelope. When an ambiguous response occurs (`isHorizonWriteUncertain` or `tx_bad_seq`), we actively query Horizon for the pre-calculated hash. If it landed, we return success without risking a duplicate spend. Re-building the envelope with a fresh sequence number only happens on genuine `tx_bad_seq` conflicts.
- **apps/api/test/stellarAdapter.test.js**: Added a test verifying that timeouts followed by `tx_bad_seq` gracefully query Horizon and return success without a duplicate network request.

## Testing
- `npm run test`: Pass
- `npm run lint`: Pass
