-- Use UUID-based identifiers for IndividualTransaction rows to avoid cross-system collisions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE "IndividualTransaction"
  ALTER COLUMN "transactionId" SET DEFAULT concat('IT', replace(gen_random_uuid()::text, '-', ''));

DROP SEQUENCE IF EXISTS "IndividualTransaction_transactionId_seq";
