-- Add lottery status tracking and voucher metadata

-- Create enum for draw status
CREATE TYPE "LotteryStatus" AS ENUM ('UNUSED', 'USED', 'EXPIRED');

-- Add columns to LotteryDraw
ALTER TABLE "LotteryDraw"
  ADD COLUMN "status" "LotteryStatus" NOT NULL DEFAULT 'UNUSED',
  ADD COLUMN "code" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMPTZ,
  ADD COLUMN "consumeAt" TIMESTAMPTZ;

-- Unique code per draw (allows multiple NULLs)
CREATE UNIQUE INDEX "LotteryDraw_code_key" ON "LotteryDraw"("code");
