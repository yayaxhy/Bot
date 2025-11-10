CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE','USED','EXPIRED');
ALTER TABLE "Coupon"
  ADD COLUMN "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE';
UPDATE "Coupon" SET "status" = CASE
  WHEN "consumedAt" IS NOT NULL THEN 'USED'::"CouponStatus"
  WHEN "expiresAt" <= CURRENT_TIMESTAMP THEN 'EXPIRED'::"CouponStatus"
  ELSE 'ACTIVE'::"CouponStatus"
END;
