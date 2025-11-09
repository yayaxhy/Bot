/*
  Warnings:

  - You are about to drop the column `Orderid` on the `Transaction` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[orderID]` on the table `Commission` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[orderID]` on the table `Transaction` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Commission" ADD COLUMN     "orderID" INTEGER;

-- AlterTable
ALTER TABLE "Gift" ALTER COLUMN "price" DROP NOT NULL,
ALTER COLUMN "price" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN "Orderid",
ADD COLUMN     "orderID" SERIAL NOT NULL;

-- CreateTable
CREATE TABLE "PEIWAN" (
    "PEIWANID" INTEGER NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "defaultQuotation" INTEGER NOT NULL DEFAULT 50,
    "commissionRate" DECIMAL(19,4) NOT NULL DEFAULT 0.75,
    "MP_url" TEXT,

    CONSTRAINT "PEIWAN_pkey" PRIMARY KEY ("PEIWANID")
);

-- CreateIndex
CREATE UNIQUE INDEX "PEIWAN_discordUserId_key" ON "PEIWAN"("discordUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Commission_orderID_key" ON "Commission"("orderID");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_orderID_key" ON "Transaction"("orderID");

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_orderID_fkey" FOREIGN KEY ("orderID") REFERENCES "Transaction"("orderID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PEIWAN" ADD CONSTRAINT "PEIWAN_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "Member"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE;
