CREATE TABLE "Sep10Challenge" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Sep10Challenge_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RestSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RestSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Sep10Challenge_challengeHash_key" ON "Sep10Challenge"("challengeHash");
CREATE INDEX "Sep10Challenge_account_createdAt_idx" ON "Sep10Challenge"("account", "createdAt");
CREATE INDEX "Sep10Challenge_expiresAt_idx" ON "Sep10Challenge"("expiresAt");
CREATE UNIQUE INDEX "RestSession_tokenHash_key" ON "RestSession"("tokenHash");
CREATE INDEX "RestSession_userId_expiresAt_idx" ON "RestSession"("userId", "expiresAt");
CREATE INDEX "RestSession_expiresAt_idx" ON "RestSession"("expiresAt");
ALTER TABLE "RestSession" ADD CONSTRAINT "RestSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
