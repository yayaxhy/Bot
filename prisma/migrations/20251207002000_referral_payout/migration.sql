-- Tracks referral commission payouts per order (1% rule)

CREATE TABLE "ReferralPayout" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferralPayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferralPayout_referralId_orderId_key" ON "ReferralPayout"("referralId", "orderId");

ALTER TABLE "ReferralPayout"
  ADD CONSTRAINT "ReferralPayout_referralId_fkey"
    FOREIGN KEY ("referralId") REFERENCES "Referral"("inviteeId") ON DELETE CASCADE ON UPDATE CASCADE;
