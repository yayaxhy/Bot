-- Add prize usage amount and order reference to LotteryDraw
ALTER TABLE "LotteryDraw"
  ADD COLUMN "consumeAmount" DECIMAL(19,4),
  ADD COLUMN "consumeOrderId" TEXT;

CREATE INDEX "LotteryDraw_consumeOrderId_idx" ON "LotteryDraw"("consumeOrderId");
