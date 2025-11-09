-- CreateSequence
CREATE SEQUENCE "IndividualTransaction_transactionId_seq";

-- CreateTable
CREATE TABLE "IndividualTransaction" (
    "transactionId" TEXT NOT NULL DEFAULT concat('IT', nextval('"IndividualTransaction_transactionId_seq"'::regclass)),
    "timeCreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discordId" TEXT NOT NULL,
    "thirdPartydiscordId" TEXT NOT NULL,
    "balanceBefore" DECIMAL(19,4) NOT NULL,
    "amountChange" DECIMAL(19,4) NOT NULL,
    "balanceAfter" DECIMAL(19,4) NOT NULL,
    "typeOfTransaction" TEXT NOT NULL,
    CONSTRAINT "IndividualTransaction_pkey" PRIMARY KEY ("transactionId")
);

-- CreateIndex
CREATE INDEX "IndividualTransaction_discordId_idx" ON "IndividualTransaction"("discordId");
