-- CreateEnum
CREATE TYPE "AuditionInviteStatus" AS ENUM (
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'FULFILLED',
  'CANCELED'
);

-- CreateTable
CREATE TABLE "AuditionRoom" (
  "bossId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "channelName" TEXT NOT NULL,
  "emptySince" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuditionRoom_pkey" PRIMARY KEY ("bossId")
);

-- CreateTable
CREATE TABLE "AuditionInvite" (
  "id" TEXT NOT NULL,
  "orderRequestId" TEXT NOT NULL,
  "bossId" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "peiwanId" INTEGER,
  "roomChannelId" TEXT NOT NULL,
  "roomGuildId" TEXT NOT NULL,
  "bossContactChannelId" TEXT,
  "workerPromptChannelId" TEXT,
  "workerPromptMessageId" TEXT,
  "status" "AuditionInviteStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "declinedAt" TIMESTAMP(3),
  "joinedAt" TIMESTAMP(3),
  "chargedAt" TIMESTAMP(3),
  "fulfilledAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "bossRoomNoticeSentAt" TIMESTAMP(3),
  "transactionId" TEXT,
  "grossAmount" DECIMAL(19,4),
  "feeAmount" DECIMAL(19,4),
  "netAmount" DECIMAL(19,4),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuditionInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditionRoom_channelId_key" ON "AuditionRoom"("channelId");

-- CreateIndex
CREATE INDEX "AuditionRoom_guildId_categoryId_idx" ON "AuditionRoom"("guildId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditionInvite_transactionId_key" ON "AuditionInvite"("transactionId");

-- CreateIndex
CREATE INDEX "AuditionInvite_orderRequestId_createdAt_idx" ON "AuditionInvite"("orderRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditionInvite_bossId_status_createdAt_idx" ON "AuditionInvite"("bossId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditionInvite_workerId_status_createdAt_idx" ON "AuditionInvite"("workerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditionInvite_roomChannelId_status_createdAt_idx" ON "AuditionInvite"("roomChannelId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditionInvite_expiresAt_status_idx" ON "AuditionInvite"("expiresAt", "status");

-- AddForeignKey
ALTER TABLE "AuditionRoom"
  ADD CONSTRAINT "AuditionRoom_bossId_fkey"
  FOREIGN KEY ("bossId") REFERENCES "Member"("discordUserId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditionInvite"
  ADD CONSTRAINT "AuditionInvite_bossId_fkey"
  FOREIGN KEY ("bossId") REFERENCES "Member"("discordUserId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditionInvite"
  ADD CONSTRAINT "AuditionInvite_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "Member"("discordUserId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditionInvite"
  ADD CONSTRAINT "AuditionInvite_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("Transid")
  ON DELETE SET NULL ON UPDATE CASCADE;
