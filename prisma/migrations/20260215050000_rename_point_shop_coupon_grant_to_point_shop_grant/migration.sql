-- Point shop: rename PointShopCouponGrant to PointShopGrant

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'PointShopCouponGrant'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'PointShopGrant'
  ) THEN
    ALTER TABLE "PointShopCouponGrant" RENAME TO "PointShopGrant";
  END IF;
END $$;

ALTER INDEX IF EXISTS "PointShopCouponGrant_discordUserId_status_expiresAt_idx"
  RENAME TO "PointShopGrant_discordUserId_couponStatus_expiresAt_idx";
ALTER INDEX IF EXISTS "PointShopCouponGrant_orderId_idx"
  RENAME TO "PointShopGrant_orderId_idx";
ALTER INDEX IF EXISTS "PointShopCouponGrant_orderItemId_idx"
  RENAME TO "PointShopGrant_orderItemId_idx";
ALTER INDEX IF EXISTS "PointShopCouponGrant_consumeTargetId_idx"
  RENAME TO "PointShopGrant_consumeTargetId_idx";
ALTER INDEX IF EXISTS "PointShopCouponGrant_discordUserId_deliveryType_deliveryStatus_createdAt_idx"
  RENAME TO "PointShopGrant_discordUserId_deliveryType_deliveryStatus_createdAt_idx";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopCouponGrant_orderId_fkey'
  ) THEN
    ALTER TABLE "PointShopGrant"
      RENAME CONSTRAINT "PointShopCouponGrant_orderId_fkey"
      TO "PointShopGrant_orderId_fkey";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopCouponGrant_orderItemId_fkey'
  ) THEN
    ALTER TABLE "PointShopGrant"
      RENAME CONSTRAINT "PointShopCouponGrant_orderItemId_fkey"
      TO "PointShopGrant_orderItemId_fkey";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopCouponGrant_discordUserId_fkey'
  ) THEN
    ALTER TABLE "PointShopGrant"
      RENAME CONSTRAINT "PointShopCouponGrant_discordUserId_fkey"
      TO "PointShopGrant_discordUserId_fkey";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopCouponGrant_consumeTargetId_fkey'
  ) THEN
    ALTER TABLE "PointShopGrant"
      RENAME CONSTRAINT "PointShopCouponGrant_consumeTargetId_fkey"
      TO "PointShopGrant_consumeTargetId_fkey";
  END IF;
END $$;
