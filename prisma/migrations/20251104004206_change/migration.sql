/*
  Warnings:

  - The values [DEFAULT] on the enum `QuotationCode` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "QuotationCode_new" AS ENUM ('Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7');
ALTER TABLE "PEIWAN" ALTER COLUMN "defaultQuotationCode" TYPE "QuotationCode_new" USING ("defaultQuotationCode"::text::"QuotationCode_new");
ALTER TABLE "Order" ALTER COLUMN "quotationCode" TYPE "QuotationCode_new" USING ("quotationCode"::text::"QuotationCode_new");
ALTER TYPE "QuotationCode" RENAME TO "QuotationCode_old";
ALTER TYPE "QuotationCode_new" RENAME TO "QuotationCode";
DROP TYPE "public"."QuotationCode_old";
COMMIT;
