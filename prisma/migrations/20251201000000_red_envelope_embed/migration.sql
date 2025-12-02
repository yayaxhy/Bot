-- CreateEnum
CREATE TYPE "RedEnvelopeStatus" AS ENUM ('ACTIVE', 'FINISHED', 'REFUNDED');

-- CreateTable
CREATE TABLE "RedEnvelope" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "totalAmount" DECIMAL(19,4) NOT NULL,
    "remainingAmount" DECIMAL(19,4) NOT NULL,
    "totalCount" INTEGER NOT NULL,
    "remainingCount" INTEGER NOT NULL,
    "note" TEXT,
    "status" "RedEnvelopeStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "messageId" TEXT,
    "channelId" TEXT,
    "refundedAmount" DECIMAL(19,4),
    "incomePool" DECIMAL(19,4) NOT NULL,
    "rechargePool" DECIMAL(19,4) NOT NULL,

    CONSTRAINT "RedEnvelope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RedEnvelope_status_expiresAt_idx" ON "RedEnvelope"("status", "expiresAt");


