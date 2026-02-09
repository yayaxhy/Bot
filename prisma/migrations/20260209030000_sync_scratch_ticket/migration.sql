DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ScratchTicketStatus') THEN
    CREATE TYPE "ScratchTicketStatus" AS ENUM ('UNSOLD', 'SOLD', 'REVEALED');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ScratchPrizeType') THEN
    CREATE TYPE "ScratchPrizeType" AS ENUM (
      'THANKS',
      'P5',
      'P10',
      'P20',
      'P30',
      'P50',
      'P52',
      'P100',
      'P150',
      'P99',
      'P200'
    );
  END IF;
END
$$;

ALTER TYPE "ScratchPrizeType" ADD VALUE IF NOT EXISTS 'THANKS';
ALTER TYPE "ScratchPrizeType" ADD VALUE IF NOT EXISTS 'P5';
ALTER TYPE "ScratchPrizeType" ADD VALUE IF NOT EXISTS 'P10';
ALTER TYPE "ScratchPrizeType" ADD VALUE IF NOT EXISTS 'P20';
ALTER TYPE "ScratchPrizeType" ADD VALUE IF NOT EXISTS 'P30';
ALTER TYPE "ScratchPrizeType" ADD VALUE IF NOT EXISTS 'P50';
ALTER TYPE "ScratchPrizeType" ADD VALUE IF NOT EXISTS 'P52';
ALTER TYPE "ScratchPrizeType" ADD VALUE IF NOT EXISTS 'P100';
ALTER TYPE "ScratchPrizeType" ADD VALUE IF NOT EXISTS 'P150';
ALTER TYPE "ScratchPrizeType" ADD VALUE IF NOT EXISTS 'P99';
ALTER TYPE "ScratchPrizeType" ADD VALUE IF NOT EXISTS 'P200';

CREATE TABLE IF NOT EXISTS "ScratchTicket" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "serialNo" INTEGER NOT NULL,
  "status" "ScratchTicketStatus" NOT NULL DEFAULT 'UNSOLD',
  "prizeType" "ScratchPrizeType" NOT NULL,
  "prizeAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "ownerId" TEXT,
  "revealedAt" TIMESTAMP(3),
  "revealMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScratchTicket_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ScratchTicket" ADD COLUMN IF NOT EXISTS "revealMessageId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "ScratchTicket_code_key" ON "ScratchTicket"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "ScratchTicket_serialNo_key" ON "ScratchTicket"("serialNo");
CREATE INDEX IF NOT EXISTS "ScratchTicket_status_serialNo_idx" ON "ScratchTicket"("status", "serialNo");
CREATE INDEX IF NOT EXISTS "ScratchTicket_ownerId_status_idx" ON "ScratchTicket"("ownerId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ScratchTicket_ownerId_fkey'
  ) THEN
    ALTER TABLE "ScratchTicket"
      ADD CONSTRAINT "ScratchTicket_ownerId_fkey"
      FOREIGN KEY ("ownerId") REFERENCES "Member"("discordUserId") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;