ALTER TABLE "Referral"
ADD COLUMN IF NOT EXISTS "payoutRate" NUMERIC(10,4) NOT NULL DEFAULT 0.01,
ADD COLUMN IF NOT EXISTS "payoutCap" NUMERIC(19,4) DEFAULT 1000,
ADD COLUMN IF NOT EXISTS "policyApplied" BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS "policyRuleId" TEXT,
ADD COLUMN IF NOT EXISTS "policyBoundAt" TIMESTAMP(3);

UPDATE "Referral"
SET "payoutRate" = 0.01
WHERE "payoutRate" IS NULL;

UPDATE "Referral"
SET "payoutCap" = 1000
WHERE "payoutCap" IS NULL;

CREATE TABLE IF NOT EXISTS "ReferralPolicy" (
  "id" TEXT NOT NULL,
  "inviterId" TEXT NOT NULL,
  "referralType" "ReferralType",
  "rate" NUMERIC(10,4) NOT NULL,
  "capAmount" NUMERIC(19,4),
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ReferralPolicy_inviterId_enabled_createdAt_idx"
  ON "ReferralPolicy"("inviterId", "enabled", "createdAt");

CREATE INDEX IF NOT EXISTS "ReferralPolicy_referralType_enabled_createdAt_idx"
  ON "ReferralPolicy"("referralType", "enabled", "createdAt");