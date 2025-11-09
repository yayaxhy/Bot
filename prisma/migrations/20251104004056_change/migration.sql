/*
  Warnings:

  - You are about to drop the column `quotation_DEFAULT` on the `PEIWAN` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "PEIWAN" DROP COLUMN "quotation_DEFAULT",
ADD COLUMN     "quotation_Q1" DECIMAL(10,2);
