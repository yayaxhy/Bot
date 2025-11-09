/*
  Warnings:

  - Made the column `orderID` on table `Commission` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Commission" ALTER COLUMN "orderID" SET NOT NULL;
