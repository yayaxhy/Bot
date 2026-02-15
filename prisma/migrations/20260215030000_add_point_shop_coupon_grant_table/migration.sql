-- Point shop: coupon deliveries are tracked in a dedicated table

CREATE TABLE IF NOT EXISTS "PointShopCouponGrant" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "couponType" "CouponType" NOT NULL,
  "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "consumeAmount" DECIMAL(19,4),
  "consumeTargetId" TEXT,
  "consumeOrderId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PointShopCouponGrant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PointShopCouponGrant_discordUserId_status_expiresAt_idx"
  ON "PointShopCouponGrant"("discordUserId", "status", "expiresAt");
CREATE INDEX IF NOT EXISTS "PointShopCouponGrant_orderId_idx"
  ON "PointShopCouponGrant"("orderId");
CREATE INDEX IF NOT EXISTS "PointShopCouponGrant_orderItemId_idx"
  ON "PointShopCouponGrant"("orderItemId");
CREATE INDEX IF NOT EXISTS "PointShopCouponGrant_consumeTargetId_idx"
  ON "PointShopCouponGrant"("consumeTargetId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopCouponGrant_orderId_fkey'
  ) THEN
    ALTER TABLE "PointShopCouponGrant"
      ADD CONSTRAINT "PointShopCouponGrant_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "PointShopOrder"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopCouponGrant_orderItemId_fkey'
  ) THEN
    ALTER TABLE "PointShopCouponGrant"
      ADD CONSTRAINT "PointShopCouponGrant_orderItemId_fkey"
      FOREIGN KEY ("orderItemId") REFERENCES "PointShopOrderItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopCouponGrant_discordUserId_fkey'
  ) THEN
    ALTER TABLE "PointShopCouponGrant"
      ADD CONSTRAINT "PointShopCouponGrant_discordUserId_fkey"
      FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PointShopCouponGrant_consumeTargetId_fkey'
  ) THEN
    ALTER TABLE "PointShopCouponGrant"
      ADD CONSTRAINT "PointShopCouponGrant_consumeTargetId_fkey"
      FOREIGN KEY ("consumeTargetId") REFERENCES "Member"("discordUserId")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
