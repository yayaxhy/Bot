/*
  Warnings:

  - The primary key for the `Gift` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `Giftid` on the `Gift` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[GiftName]` on the table `Gift` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Gift" DROP CONSTRAINT "Gift_pkey",
DROP COLUMN "Giftid";

-- CreateIndex
CREATE UNIQUE INDEX "Gift_GiftName_key" ON "Gift"("GiftName");
