-- AlterTable: deposit-poller cursor storage on Wallet rows.
-- A null cursor means the wallet has never been polled; the first poll
-- sets it to the current Horizon page cursor without notifying, so old
-- payment history is never replayed as new deposits.
ALTER TABLE "Wallet" ADD COLUMN "paymentCursor" TEXT;
