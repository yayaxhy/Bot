-- Add order_audit table for exact order rollback (similar to gift_audit)
CREATE TABLE IF NOT EXISTS "order_audit" (
    "id" TEXT PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "transactionOrderId" INTEGER NOT NULL,
    "hostIndividualTransactionId" TEXT,
    "workerIndividualTransactionId" TEXT,
    "hostId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "peiwanId" INTEGER NOT NULL,
    "gross" NUMERIC(19,4) NOT NULL,
    "pointsEarned" NUMERIC(19,4) NOT NULL,
    "feeAmount" NUMERIC(19,4) NOT NULL,
    "netAmount" NUMERIC(19,4) NOT NULL,
    "commissionRate" NUMERIC(19,6) NOT NULL,
    "hostFromIncome" NUMERIC(19,4) NOT NULL,
    "hostFromRecharge" NUMERIC(19,4) NOT NULL,
    "spendBonusExtra" NUMERIC(19,4) NOT NULL,
    "spendRemainingBefore" NUMERIC(19,4) NOT NULL,
    "bossReferralInviterId" TEXT,
    "bossReferralAmount" NUMERIC(19,4),
    "workerReferralInviterId" TEXT,
    "workerReferralAmount" NUMERIC(19,4),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "order_audit_orderId_key"
    ON "order_audit" ("orderId");

CREATE UNIQUE INDEX IF NOT EXISTS "order_audit_paymentTransactionId_key"
    ON "order_audit" ("paymentTransactionId");

CREATE UNIQUE INDEX IF NOT EXISTS "order_audit_transactionOrderId_key"
    ON "order_audit" ("transactionOrderId");

CREATE UNIQUE INDEX IF NOT EXISTS "order_audit_hostIndividualTransactionId_key"
    ON "order_audit" ("hostIndividualTransactionId");

CREATE UNIQUE INDEX IF NOT EXISTS "order_audit_workerIndividualTransactionId_key"
    ON "order_audit" ("workerIndividualTransactionId");
