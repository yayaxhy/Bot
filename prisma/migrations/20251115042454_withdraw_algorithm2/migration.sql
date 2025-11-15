-- CreateSequence
CREATE SEQUENCE IF NOT EXISTS "Withdraw_id_seq";

-- AlterTable
ALTER TABLE "Withdraw" ALTER COLUMN "id" SET DEFAULT concat('W', nextval('"Withdraw_id_seq"'::regclass));
