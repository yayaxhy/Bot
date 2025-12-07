-- Referral table and enum

CREATE TYPE "ReferralType" AS ENUM ('LAOBAN', 'PEIWAN');

CREATE TABLE "Referral" (
    "inviteeId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "type" "ReferralType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Referral_pkey" PRIMARY KEY ("inviteeId")
);

CREATE INDEX "Referral_inviterId_type_idx" ON "Referral"("inviterId", "type");

ALTER TABLE "Referral"
  ADD CONSTRAINT "Referral_inviterId_fkey"
    FOREIGN KEY ("inviterId") REFERENCES "Member"("discordUserId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Referral_inviteeId_fkey"
    FOREIGN KEY ("inviteeId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE;
