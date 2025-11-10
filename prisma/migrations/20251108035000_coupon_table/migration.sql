DROP TABLE IF EXISTS "OrderDiscountUsage";
DROP TABLE IF EXISTS "Bag";

CREATE SEQUENCE IF NOT EXISTS "Coupon_id_seq";
CREATE TABLE "Coupon" (
  "id" TEXT PRIMARY KEY DEFAULT concat('C', nextval('"Coupon_id_seq"'::regclass)),
  "discordId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "orderId" TEXT
);
