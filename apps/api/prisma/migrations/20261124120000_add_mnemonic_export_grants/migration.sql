-- #960 — One-time recovery-phrase export authorization. Stores only the HASH
-- of the out-of-band challenge; never the challenge code and never the
-- mnemonic.
CREATE TABLE "MnemonicExportGrant" (
  "id"                 TEXT NOT NULL PRIMARY KEY,
  "userId"             TEXT NOT NULL,
  "walletId"           TEXT NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'pending',
  "challengeHash"      TEXT NOT NULL,
  "challengeExpiresAt" TIMESTAMP(3) NOT NULL,
  "challengeAttempts"  INTEGER NOT NULL DEFAULT 0,
  "pinVerifiedAt"      TIMESTAMP(3),
  "otpVerifiedAt"      TIMESTAMP(3),
  "authorizedAt"       TIMESTAMP(3),
  "consumedAt"         TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MnemonicExportGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MnemonicExportGrant_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MnemonicExportGrant_userId_status_idx" ON "MnemonicExportGrant"("userId", "status");
CREATE INDEX "MnemonicExportGrant_status_challengeExpiresAt_idx" ON "MnemonicExportGrant"("status", "challengeExpiresAt");
