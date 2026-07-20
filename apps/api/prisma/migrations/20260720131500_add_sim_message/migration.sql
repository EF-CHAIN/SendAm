-- CreateTable
CREATE TABLE "SimMessage" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SimMessage_phoneNumber_createdAt_idx" ON "SimMessage"("phoneNumber", "createdAt");
