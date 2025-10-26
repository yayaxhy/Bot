-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('LAOBAN', 'PEIWAN');

-- CreateEnum
CREATE TYPE "EntryKind" AS ENUM ('DIANDAN', 'DASHANG', 'TIXIAN', 'RECHARGE');

-- CreateTable
CREATE TABLE "Member" (
    "discordUserId" TEXT NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'LAOBAN',
    "balance" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "totalSpent" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "commissionRate" DECIMAL(7,6) NOT NULL DEFAULT 0.75,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("discordUserId")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "Transid" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "feeAmount" DECIMAL(19,4) NOT NULL,
    "netAmount" DECIMAL(19,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("Transid")
);

-- CreateTable
CREATE TABLE "Commission" (
    "transactionId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "feeAmount" DECIMAL(19,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commission_pkey" PRIMARY KEY ("transactionId")
);

-- CreateTable
CREATE TABLE "InteractionLog" (
    "Interid" TEXT NOT NULL,
    "memberId" TEXT,
    "command" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InteractionLog_pkey" PRIMARY KEY ("Interid")
);

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Member"("discordUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Member"("discordUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("Transid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Member"("discordUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Member"("discordUserId") ON DELETE RESTRICT ON UPDATE CASCADE;
