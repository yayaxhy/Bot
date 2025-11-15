-- DropIndex
DROP INDEX "public"."Withdraw_discordId_key";

-- CreateIndex
CREATE INDEX "Withdraw_discordId_idx" ON "Withdraw"("discordId");
