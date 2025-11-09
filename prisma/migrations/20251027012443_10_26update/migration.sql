/*
  Warnings:

  - You are about to drop the column `Orderid` on the `InteractionLog` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "InteractionLog" DROP COLUMN "Orderid";

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "Orderid" SERIAL NOT NULL;
