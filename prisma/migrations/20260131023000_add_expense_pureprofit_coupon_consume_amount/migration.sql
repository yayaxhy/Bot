ALTER TABLE "Coupon"
ADD COLUMN "consumeAmount" DECIMAL(19,4),
ADD COLUMN "consumeTargetId" TEXT;

CREATE TABLE "Expense" (
  "id" TEXT NOT NULL,
  "amount" DECIMAL(19,4) NOT NULL,
  "operatorId" TEXT NOT NULL,
  "targetId" TEXT,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PureProfit" (
  "id" TEXT NOT NULL,
  "amount" DECIMAL(19,4) NOT NULL,
  "operatorId" TEXT NOT NULL,
  "targetId" TEXT,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PureProfit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Expense_operatorId_idx" ON "Expense"("operatorId");
CREATE INDEX "Expense_targetId_idx" ON "Expense"("targetId");
CREATE INDEX "Expense_createdAt_idx" ON "Expense"("createdAt");

CREATE INDEX "PureProfit_operatorId_idx" ON "PureProfit"("operatorId");
CREATE INDEX "PureProfit_targetId_idx" ON "PureProfit"("targetId");
CREATE INDEX "PureProfit_createdAt_idx" ON "PureProfit"("createdAt");

ALTER TABLE "Expense"
ADD CONSTRAINT "Expense_operatorId_fkey"
FOREIGN KEY ("operatorId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Expense"
ADD CONSTRAINT "Expense_targetId_fkey"
FOREIGN KEY ("targetId") REFERENCES "Member"("discordUserId") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PureProfit"
ADD CONSTRAINT "PureProfit_operatorId_fkey"
FOREIGN KEY ("operatorId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PureProfit"
ADD CONSTRAINT "PureProfit_targetId_fkey"
FOREIGN KEY ("targetId") REFERENCES "Member"("discordUserId") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Coupon"
ADD CONSTRAINT "Coupon_consumeTargetId_fkey"
FOREIGN KEY ("consumeTargetId") REFERENCES "Member"("discordUserId") ON DELETE SET NULL ON UPDATE CASCADE;
