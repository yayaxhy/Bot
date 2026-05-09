ALTER TYPE "CouponType" ADD VALUE IF NOT EXISTS 'BLOCK_STACK_VOUCHER';

DO $$
BEGIN
  CREATE TYPE "CouponSource" AS ENUM (
    'UNKNOWN',
    'CHAT_DROP',
    'MANUAL_GRANT',
    'VIP_BENEFIT',
    'GIFT_WALL'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Coupon"
  ADD COLUMN IF NOT EXISTS "source" "CouponSource" NOT NULL DEFAULT 'UNKNOWN';

CREATE INDEX IF NOT EXISTS "Coupon_source_issuedAt_idx"
  ON "Coupon"("source", "issuedAt");
