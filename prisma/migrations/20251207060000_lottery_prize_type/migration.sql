-- Add type to LotteryPrize
CREATE TYPE "LotteryPrizeType" AS ENUM ('COUPON', 'GIFT', 'OTHER', 'SELFUSE');

ALTER TABLE "LotteryPrize"
  ADD COLUMN "type" "LotteryPrizeType" NOT NULL DEFAULT 'COUPON';
