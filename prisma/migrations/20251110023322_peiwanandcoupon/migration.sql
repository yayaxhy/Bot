/*
  Warnings:

  - Changed the type of `type` on the `Coupon` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "CouponType" AS ENUM ('DISCOUNT_90');

-- AlterTable
ALTER TABLE "Coupon" DROP COLUMN "type",
ADD COLUMN     "type" "CouponType" NOT NULL;
