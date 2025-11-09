/*
  Warnings:

  - You are about to drop the column `defaultQuotation` on the `PEIWAN` table. All the data in the column will be lost.
  - You are about to alter the column `commissionRate` on the `PEIWAN` table. The data in that column could be lost. The data in that column will be cast from `Decimal(19,4)` to `Decimal(7,6)`.
  - Added the required column `defaultQuotationCode` to the `PEIWAN` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `PEIWAN` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "OrderMode" AS ENUM ('REALNAME', 'ANONYMOUS');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'RUNNING', 'ENDED', 'DECLINED', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QuotationCode" AS ENUM ('DEFAULT', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7');

-- AlterTable
ALTER TABLE "PEIWAN" DROP COLUMN "defaultQuotation",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "defaultQuotationCode" "QuotationCode" NOT NULL,
ADD COLUMN     "quotation_DEFAULT" DECIMAL(10,2),
ADD COLUMN     "quotation_Q2" DECIMAL(10,2),
ADD COLUMN     "quotation_Q3" DECIMAL(10,2),
ADD COLUMN     "quotation_Q4" DECIMAL(10,2),
ADD COLUMN     "quotation_Q5" DECIMAL(10,2),
ADD COLUMN     "quotation_Q6" DECIMAL(10,2),
ADD COLUMN     "quotation_Q7" DECIMAL(10,2),
ADD COLUMN     "techTag" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "commissionRate" SET DATA TYPE DECIMAL(7,6);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "peiwanId" INTEGER NOT NULL,
    "mode" "OrderMode" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "quotationCode" "QuotationCode" NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "billableStartAt" TIMESTAMP(3),
    "stopwatchStartAt" TIMESTAMP(3),
    "cutoffAt" TIMESTAMP(3),
    "maxMinutesAtAccept" INTEGER,
    "lastRecalcAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "totalMinutes" INTEGER,
    "grossAmount" DECIMAL(18,2),
    "commissionRate" DECIMAL(7,6),
    "netAmount" DECIMAL(18,2),
    "interId" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerLock" (
    "workerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "HeartCounter" (
    "id" SERIAL NOT NULL,
    "fromMemberId" TEXT NOT NULL,
    "toMemberId" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HeartCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_status_cutoffAt_idx" ON "Order"("status", "cutoffAt");

-- CreateIndex
CREATE INDEX "Order_workerId_status_idx" ON "Order"("workerId", "status");

-- CreateIndex
CREATE INDEX "Order_hostId_status_idx" ON "Order"("hostId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerLock_workerId_key" ON "WorkerLock"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerLock_orderId_key" ON "WorkerLock"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "HeartCounter_fromMemberId_toMemberId_key" ON "HeartCounter"("fromMemberId", "toMemberId");

-- CreateIndex
CREATE INDEX "PEIWAN_status_idx" ON "PEIWAN"("status");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Member"("discordUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Member"("discordUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_peiwanId_fkey" FOREIGN KEY ("peiwanId") REFERENCES "PEIWAN"("PEIWANID") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerLock" ADD CONSTRAINT "WorkerLock_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerLock" ADD CONSTRAINT "WorkerLock_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeartCounter" ADD CONSTRAINT "HeartCounter_fromMemberId_fkey" FOREIGN KEY ("fromMemberId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeartCounter" ADD CONSTRAINT "HeartCounter_toMemberId_fkey" FOREIGN KEY ("toMemberId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE;
