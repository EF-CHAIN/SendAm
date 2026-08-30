-- CreateTable
CREATE TABLE "SecretRotation" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "rotatedBy" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecretRotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecretRotation_category_rotatedAt_idx" ON "SecretRotation"("category", "rotatedAt");

-- CreateIndex
CREATE INDEX "SecretRotation_expiresAt_idx" ON "SecretRotation"("expiresAt");

-- CreateIndex
CREATE INDEX "SecretRotation_category_expiresAt_idx" ON "SecretRotation"("category", "expiresAt");
