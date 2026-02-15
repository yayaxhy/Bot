-- Point shop: store all purchased goods in PointShopCouponGrant

ALTER TABLE "PointShopCouponGrant"
  ADD COLUMN IF NOT EXISTS "deliveryType" "PointShopDeliveryType" NOT NULL DEFAULT 'COUPON',
  ADD COLUMN IF NOT EXISTS "itemSku" TEXT,
  ADD COLUMN IF NOT EXISTS "itemName" TEXT,
  ADD COLUMN IF NOT EXISTS "quantity" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "unitPoints" DECIMAL(19,4),
  ADD COLUMN IF NOT EXISTS "subtotalPoints" DECIMAL(19,4),
  ADD COLUMN IF NOT EXISTS "deliveryStatus" "PointShopDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "deliveryNote" TEXT;

UPDATE "PointShopCouponGrant"
SET
  "itemSku" = COALESCE("itemSku", 'UNKNOWN'),
  "itemName" = COALESCE("itemName", 'UNKNOWN'),
  "unitPoints" = COALESCE("unitPoints", 0),
  "subtotalPoints" = COALESCE("subtotalPoints", 0),
  "deliveryStatus" = CASE
    WHEN "deliveryStatus" IS NULL THEN 'DELIVERED'::"PointShopDeliveryStatus"
    ELSE "deliveryStatus"
  END
WHERE
  "itemSku" IS NULL
  OR "itemName" IS NULL
  OR "unitPoints" IS NULL
  OR "subtotalPoints" IS NULL
  OR "deliveryStatus" IS NULL;

ALTER TABLE "PointShopCouponGrant"
  ALTER COLUMN "couponType" DROP NOT NULL,
  ALTER COLUMN "status" DROP NOT NULL,
  ALTER COLUMN "expiresAt" DROP NOT NULL,
  ALTER COLUMN "itemSku" SET NOT NULL,
  ALTER COLUMN "itemName" SET NOT NULL,
  ALTER COLUMN "unitPoints" SET NOT NULL,
  ALTER COLUMN "subtotalPoints" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "PointShopCouponGrant_discordUserId_deliveryType_deliveryStatus_createdAt_idx"
  ON "PointShopCouponGrant"("discordUserId", "deliveryType", "deliveryStatus", "createdAt");
