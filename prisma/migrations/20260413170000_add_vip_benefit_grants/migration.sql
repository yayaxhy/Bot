ALTER TYPE "CouponType" ADD VALUE IF NOT EXISTS 'SCRATCH_TICKET_VOUCHER';

ALTER TABLE "RedEnvelope"
ADD COLUMN "pointsAwarded" DECIMAL(19, 4) NOT NULL DEFAULT 0;

CREATE TYPE "VipBenefitDeliveryKind" AS ENUM ('COUPON', 'LOTTERY', 'POINTS');
CREATE TYPE "VipBenefitInstanceStatus" AS ENUM ('ACTIVE', 'REVOKED', 'FINALIZED');

CREATE TABLE "VipBenefitGrant" (
  "id" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "vipLevel" INTEGER NOT NULL,
  "benefitCode" TEXT NOT NULL,
  "benefitLabel" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VipBenefitGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VipBenefitGrantInstance" (
  "id" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "deliveryKind" "VipBenefitDeliveryKind" NOT NULL,
  "status" "VipBenefitInstanceStatus" NOT NULL DEFAULT 'ACTIVE',
  "couponType" "CouponType",
  "lotteryPrizeName" TEXT,
  "pointsAmount" DECIMAL(19, 4),
  "sourceCouponId" TEXT,
  "sourceLotteryDrawId" TEXT,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VipBenefitGrantInstance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VipBenefitGrant_discordUserId_benefitCode_key"
ON "VipBenefitGrant"("discordUserId", "benefitCode");

CREATE INDEX "VipBenefitGrant_discordUserId_vipLevel_idx"
ON "VipBenefitGrant"("discordUserId", "vipLevel");

CREATE UNIQUE INDEX "VipBenefitGrantInstance_grantId_sequence_key"
ON "VipBenefitGrantInstance"("grantId", "sequence");

CREATE INDEX "VipBenefitGrantInstance_grantId_status_idx"
ON "VipBenefitGrantInstance"("grantId", "status");

CREATE INDEX "VipBenefitGrantInstance_sourceCouponId_idx"
ON "VipBenefitGrantInstance"("sourceCouponId");

CREATE INDEX "VipBenefitGrantInstance_sourceLotteryDrawId_idx"
ON "VipBenefitGrantInstance"("sourceLotteryDrawId");

ALTER TABLE "VipBenefitGrant"
ADD CONSTRAINT "VipBenefitGrant_discordUserId_fkey"
FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VipBenefitGrantInstance"
ADD CONSTRAINT "VipBenefitGrantInstance_grantId_fkey"
FOREIGN KEY ("grantId") REFERENCES "VipBenefitGrant"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
