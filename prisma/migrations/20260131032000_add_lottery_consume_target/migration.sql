ALTER TABLE "LotteryDraw" ADD COLUMN IF NOT EXISTS "consumeTargetId" TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'LotteryDraw_consumeTargetId_fkey'
  ) THEN
    ALTER TABLE "LotteryDraw"
      ADD CONSTRAINT "LotteryDraw_consumeTargetId_fkey"
      FOREIGN KEY ("consumeTargetId") REFERENCES "Member"("discordUserId")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "LotteryDraw_consumeTargetId_idx" ON "LotteryDraw"("consumeTargetId");
