-- Add RechargeOrderStatus enum and ZPayRechargeOrder table
CREATE TYPE "RechargeOrderStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

CREATE TABLE "ZPayRechargeOrder" (
  "id" TEXT NOT NULL DEFAULT concat('ZPAY', replace((gen_random_uuid())::text, '-'::text, ''::text)),
  "outTradeNo" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "amount" DECIMAL(19,4) NOT NULL,
  "channel" TEXT NOT NULL,
  "status" "RechargeOrderStatus" NOT NULL DEFAULT 'PENDING',
  "gatewayTradeNo" TEXT,
  "notifyPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "ZPayRechargeOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ZPayRechargeOrder_outTradeNo_key" ON "ZPayRechargeOrder"("outTradeNo");
CREATE INDEX "ZPayRechargeOrder_status_createdAt_idx" ON "ZPayRechargeOrder"("status", "createdAt");

ALTER TABLE "ZPayRechargeOrder" ADD CONSTRAINT "ZPayRechargeOrder_discordUserId_fkey"
  FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE;