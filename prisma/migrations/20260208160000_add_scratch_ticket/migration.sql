CREATE TYPE "ScratchTicketStatus" AS ENUM ('UNSOLD', 'SOLD', 'REVEALED');

CREATE TYPE "ScratchPrizeType" AS ENUM ('THANKS', 'P5', 'P10', 'P20', 'P30', 'P50', 'P52', 'P100', 'P150', 'P200');

CREATE TABLE "ScratchTicket" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "serialNo" INTEGER NOT NULL,
  "status" "ScratchTicketStatus" NOT NULL DEFAULT 'UNSOLD',
  "prizeType" "ScratchPrizeType" NOT NULL,
  "prizeAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "prizeImageUrl" TEXT,
  "ownerId" TEXT,
  "soldAt" TIMESTAMP(3),
  "revealedAt" TIMESTAMP(3),
  "soldMessageId" TEXT,
  "revealMessageId" TEXT,
  "purchaseTransactionId" TEXT,
  "rewardTransactionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ScratchTicket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScratchTicket_code_key" ON "ScratchTicket"("code");
CREATE UNIQUE INDEX "ScratchTicket_serialNo_key" ON "ScratchTicket"("serialNo");
CREATE INDEX "ScratchTicket_status_serialNo_idx" ON "ScratchTicket"("status", "serialNo");
CREATE INDEX "ScratchTicket_ownerId_status_idx" ON "ScratchTicket"("ownerId", "status");

ALTER TABLE "ScratchTicket"
ADD CONSTRAINT "ScratchTicket_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "Member"("discordUserId")
ON DELETE SET NULL
ON UPDATE CASCADE;
