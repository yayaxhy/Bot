-- Add GiftAudit and Revert tables to align with bot schema
CREATE TABLE IF NOT EXISTS "gift_audit" (
    "id" TEXT PRIMARY KEY,
    "paymentTransactionId" TEXT NOT NULL,
    "individualTransactionId" TEXT NOT NULL,
    "orderId" INTEGER NOT NULL,
    "giftName" TEXT NOT NULL,
    "quantity" NUMERIC(19,4) NOT NULL,
    "unitPrice" NUMERIC(19,4) NOT NULL,
    "gross" NUMERIC(19,4) NOT NULL,
    "payable" NUMERIC(19,4) NOT NULL,
    "feeAmount" NUMERIC(19,4) NOT NULL,
    "netAmount" NUMERIC(19,4) NOT NULL,
    "receiverRate" NUMERIC(19,6) NOT NULL,
    "heartGain" INTEGER NOT NULL,
    "giverId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "giverFromIncome" NUMERIC(19,4) NOT NULL,
    "giverFromRecharge" NUMERIC(19,4) NOT NULL,
    "spendBonusExtra" NUMERIC(19,4) NOT NULL,
    "spendRemainingBefore" NUMERIC(19,4) NOT NULL,
    "flowBonusExtra" NUMERIC(19,4) NOT NULL,
    "flowRemainingBefore" NUMERIC(19,4) NOT NULL,
    "voucherIds" JSONB,
    "bossReferralInviterId" TEXT,
    "bossReferralAmount" NUMERIC(19,4),
    "workerReferralInviterId" TEXT,
    "workerReferralAmount" NUMERIC(19,4),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "gift_audit_paymentTransactionId_key"
    ON "gift_audit" ("paymentTransactionId");

CREATE UNIQUE INDEX IF NOT EXISTS "gift_audit_individualTransactionId_key"
    ON "gift_audit" ("individualTransactionId");

CREATE TABLE IF NOT EXISTS "revert" (
    "id" TEXT PRIMARY KEY,
    "originalTransactionId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "details" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "revert_originalTransactionId_key"
    ON "revert" ("originalTransactionId");
