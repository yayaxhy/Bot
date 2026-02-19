-- Add new coupon type for point-shop-only peiwan review voucher
DO $$
BEGIN
  ALTER TYPE "CouponType" ADD VALUE IF NOT EXISTS 'PEIWAN_REVIEW_VOUCHER';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Add display mode enum used by peiwan review records
DO $$
BEGIN
  CREATE TYPE "PeiwanReviewDisplayMode" AS ENUM ('HIDDEN', 'ANONYMOUS', 'REALNAME');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Persist voucher-consumed reviews that peiwan can choose to display on MP cards
CREATE TABLE IF NOT EXISTS "PeiwanReview" (
  "id" TEXT NOT NULL,
  "sourceGrantId" TEXT,
  "reviewerDiscordId" TEXT NOT NULL,
  "reviewerName" TEXT,
  "peiwanDiscordId" TEXT NOT NULL,
  "peiwanName" TEXT,
  "peiwanId" INTEGER,
  "content" VARCHAR(500) NOT NULL,
  "displayMode" "PeiwanReviewDisplayMode" NOT NULL DEFAULT 'HIDDEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PeiwanReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PeiwanReview_sourceGrantId_key" ON "PeiwanReview"("sourceGrantId");
CREATE INDEX IF NOT EXISTS "PeiwanReview_peiwanDiscordId_displayMode_createdAt_idx"
  ON "PeiwanReview"("peiwanDiscordId", "displayMode", "createdAt");
CREATE INDEX IF NOT EXISTS "PeiwanReview_reviewerDiscordId_createdAt_idx"
  ON "PeiwanReview"("reviewerDiscordId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PeiwanReview_reviewerDiscordId_fkey'
  ) THEN
    ALTER TABLE "PeiwanReview"
      ADD CONSTRAINT "PeiwanReview_reviewerDiscordId_fkey"
      FOREIGN KEY ("reviewerDiscordId") REFERENCES "Member"("discordUserId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PeiwanReview_peiwanDiscordId_fkey'
  ) THEN
    ALTER TABLE "PeiwanReview"
      ADD CONSTRAINT "PeiwanReview_peiwanDiscordId_fkey"
      FOREIGN KEY ("peiwanDiscordId") REFERENCES "Member"("discordUserId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
